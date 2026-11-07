// Package queue는 연결 하나·세대 하나의 디스크 대기다.
//
// 기록에 순번을 붙여 세그먼트 파일에 차례로 쓰고, 수신 서버가 받았다고 확인한 순번까지
// 지운다(D05, D06). 기록마다 길이와 CRC를 달아, 쓰다 멈춰 끝이 깨진 기록은 열 때 잘라
// 낸다. 세대가 바뀌면 순번이 1부터 다시 시작하므로 부르는 쪽이 세대마다 폴더를 따로 둔다.
package queue

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
)

const (
	segMagic    = "LDQ1" // 세그먼트 형식 1
	stateFile   = "state.json"
	stateFormat = 1
	snapFile    = "positions.json" // 읽기 위치 스냅샷(Options.Snapshots)
	snapFormat  = 1
	frameHeader = 16       // 길이 4 + CRC 4 + 순번 8
	maxPayload  = 64 << 20 // 깨진 길이 값으로 큰 메모리를 잡지 않게 하는 상한
)

var (
	// ErrCorrupt는 이미 확정된 기록이 깨졌다는 뜻이다. 지우지 않고 멈춰야 한다.
	ErrCorrupt = errors.New("queue: corrupt record")
	// ErrUnsupportedFormat은 이 버전이 읽을 수 없는 형식이다. 더 새 버전이 만든 대기를
	// 되돌린 버전이 만난 경우로, 지우지 않고 보류한다(Q16-08).
	ErrUnsupportedFormat = errors.New("queue: unsupported format")
	// ErrAckBeyondEnd는 쓰지 않은 순번까지 받았다는 응답이다.
	ErrAckBeyondEnd = errors.New("queue: ack beyond last record")
)

var castagnoli = crc32.MakeTable(crc32.Castagnoli)

// Options의 기본값은 시제품용이다.
type Options struct {
	SegmentBytes int64 // 세그먼트 하나의 크기. 넘으면 다음 기록부터 새 세그먼트에 쓴다
	LimitBytes   int64 // 대기 한도. 넘으면 Full이 참이 되어 부르는 쪽이 읽기를 멈춘다(D01)
	// Snapshots는 읽는 쪽이 파일별 읽기 위치를 스냅샷으로 따로 확정한다는 뜻이다(SaveSnapshot,
	// 파일명 규칙). 그러면 스냅샷에 든 순번 뒤의 기록은 수신 확인돼도 지우지 않는다. 재시작 때
	// 스냅샷 뒤 기록을 다시 읽어야 파일마다 마지막으로 확정된 위치를 되살릴 수 있기 때문이다.
	Snapshots bool
}

func (o *Options) setDefaults() {
	if o.SegmentBytes <= 0 {
		o.SegmentBytes = 4 << 20
	}
	if o.LimitBytes <= 0 {
		o.LimitBytes = 256 << 20
	}
}

// Entry는 대기의 기록 하나다.
type Entry struct {
	Seq     uint64
	Payload []byte
}

type stateData struct {
	Format       int    `json:"format"`
	AckedThrough uint64 `json:"acked_through"`
	// Generation은 수신 서버가 정해 준 세대 번호다. 0이면 아직 받지 못했다. 받기 전에도
	// 기록은 쌓을 수 있고, 보내기만 번호를 받은 뒤에 한다.
	Generation uint16 `json:"generation,omitempty"`
}

// snapData는 읽기 위치 스냅샷 파일이다. Data는 읽는 쪽이 정한 형식이고 대기는 해석하지 않는다.
type snapData struct {
	Format  int             `json:"format"`
	Through uint64          `json:"through"` // 이 순번까지의 기록을 반영한 위치다
	Data    json.RawMessage `json:"data"`
}

type segment struct {
	path    string
	first   uint64
	last    uint64 // 마지막 순번. 아직 기록이 없으면 first-1
	size    int64  // 확정된 바이트 수. 읽기는 여기까지만 한다
	lastOff int64  // 마지막 기록의 시작 위치
}

// Queue는 여러 고루틴에서 함께 쓸 수 있다(읽는 쪽과 보내는 쪽).
type Queue struct {
	dir string
	opt Options

	mu    sync.Mutex
	acked uint64
	gen   uint16
	next  uint64
	segs  []*segment // 순번 순서
	cur   *os.File   // 마지막 세그먼트. 이어 쓰기용
	used  int64
	cut   int64 // 열 때 잘라 낸 바이트
	// snapped는 마지막으로 확정한 스냅샷의 순번이다(Options.Snapshots). 이 뒤 기록은 지우지 않는다.
	snapped uint64
}

// Open은 dir의 대기를 연다. 없으면 만든다.
func Open(dir string, opt Options) (*Queue, error) {
	opt.setDefaults()
	// 대기에는 로그 본문이 들어 있으므로 에이전트 실행 계정만 읽게 둔다.
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	q := &Queue{dir: dir, opt: opt}
	st, err := readState(dir)
	if err != nil {
		return nil, err
	}
	q.acked, q.gen = st.AckedThrough, st.Generation
	if err := q.loadSegments(); err != nil {
		return nil, err
	}
	q.next = q.acked + 1
	if n := len(q.segs); n > 0 {
		last := q.segs[n-1].last
		if q.acked > last {
			// 수신 서버가 받았다고 확인한 기록이 사라졌다. 쓰다 멈춰 깨지는 것은 아직 보내지
			// 않은 끝 기록뿐이므로 이는 이미 확정된 기록의 손상이다. 여기서 이어가면 다시 읽은
			// 기록이 새 순번을 받아 중복 저장되므로, 지우지 않고 멈춘다.
			return nil, fmt.Errorf("acked %d but last record %d: %w", q.acked, last, ErrCorrupt)
		}
		q.next = max(q.next, last+1)
	}
	if opt.Snapshots {
		through, _, ok, err := q.Snapshot()
		if err != nil {
			return nil, err
		}
		if ok && through >= q.next {
			// 스냅샷은 대기에 확정한 기록까지만 반영하므로 이럴 수 없다. 이미 확정된 기록이 사라졌다.
			return nil, fmt.Errorf("snapshot through %d but last record %d: %w", through, q.next-1, ErrCorrupt)
		}
		q.snapped = through
	}
	return q, nil
}

// CutOnOpen은 열 때 깨진 끝을 잘라 낸 바이트 수다. 진단에 쓴다. 잘라 낸 기록은 확정되지
// 않았던 것이라 읽은 위치도 그 앞으로 되돌아가 원본에서 다시 읽는다.
func (q *Queue) CutOnOpen() int64 {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.cut
}

func readState(dir string) (stateData, error) {
	b, err := os.ReadFile(filepath.Join(dir, stateFile))
	if errors.Is(err, fs.ErrNotExist) {
		st := stateData{Format: stateFormat}
		return st, writeState(dir, st)
	}
	if err != nil {
		return stateData{}, err
	}
	var st stateData
	if err := json.Unmarshal(b, &st); err != nil {
		return stateData{}, fmt.Errorf("%s: %w", stateFile, ErrCorrupt)
	}
	if st.Format > stateFormat {
		return stateData{}, fmt.Errorf("%s format %d: %w", stateFile, st.Format, ErrUnsupportedFormat)
	}
	return st, nil
}

func writeState(dir string, st stateData) error {
	b, err := json.Marshal(st)
	if err != nil {
		return err
	}
	return writeAtomic(dir, stateFile, b)
}

// writeAtomic은 파일을 원자적으로 바꾼다. 임시 파일에 쓰고 디스크에 확정한 뒤 이름을
// 바꾸므로, 도중에 멈춰도 옛 내용이나 새 내용 둘 중 하나만 남는다.
func writeAtomic(dir, name string, b []byte) error {
	tmp := filepath.Join(dir, name+".tmp")
	if err := writeFileSync(tmp, b); err != nil {
		return err
	}
	if err := os.Rename(tmp, filepath.Join(dir, name)); err != nil {
		return err
	}
	return syncDir(dir)
}

func writeFileSync(path string, b []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// syncDir은 폴더 항목(새 파일, 이름 바꾸기, 지우기)을 디스크에 확정한다.
func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func segName(first uint64) string { return fmt.Sprintf("seg-%020d.dat", first) }

// loadSegments는 세그먼트 목록을 읽는다. 앞 세그먼트들은 이름과 크기만 보고, 마지막
// 세그먼트만 끝까지 읽어 깨진 끝을 잘라 낸다. 앞 세그먼트는 다 쓰고 확정한 뒤에 다음
// 세그먼트로 넘어가므로 깨질 수 없고, 깨졌다면 읽을 때 ErrCorrupt로 알린다.
func (q *Queue) loadSegments() error {
	entries, err := os.ReadDir(q.dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, "seg-") || !strings.HasSuffix(name, ".dat") {
			continue
		}
		first, err := strconv.ParseUint(strings.TrimSuffix(strings.TrimPrefix(name, "seg-"), ".dat"), 10, 64)
		if err != nil {
			continue
		}
		q.segs = append(q.segs, &segment{path: filepath.Join(q.dir, name), first: first})
	}
	sort.Slice(q.segs, func(i, j int) bool { return q.segs[i].first < q.segs[j].first })

	for i, s := range q.segs {
		fi, err := os.Stat(s.path)
		if err != nil {
			return err
		}
		s.size = fi.Size()
		q.used += s.size
		if i+1 < len(q.segs) {
			s.last = q.segs[i+1].first - 1
		}
	}
	for len(q.segs) > 0 {
		last := q.segs[len(q.segs)-1]
		if err := q.recoverTail(last); err != nil {
			return err
		}
		if last.last >= last.first {
			break
		}
		// 기록이 하나도 없는 마지막 세그먼트(만든 직후 멈춘 경우)는 지운다.
		q.used -= last.size
		if err := os.Remove(last.path); err != nil {
			return err
		}
		q.segs = q.segs[:len(q.segs)-1]
	}
	return nil
}

// recoverTail은 마지막 세그먼트를 끝까지 읽어 마지막 온전한 기록 뒤를 잘라 낸다.
func (q *Queue) recoverTail(s *segment) error {
	f, err := os.OpenFile(s.path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := checkMagic(f); err != nil {
		return fmt.Errorf("%s: %w", s.path, err)
	}
	s.last = s.first - 1
	valid, err := scan(bufio.NewReader(f), int64(len(segMagic)), func(off int64, seq uint64, _ []byte) error {
		if seq != s.last+1 {
			return ErrCorrupt
		}
		s.last, s.lastOff = seq, off
		return nil
	})
	if err != nil && !errors.Is(err, errTorn) {
		return fmt.Errorf("%s: %w", s.path, err)
	}
	if valid < s.size {
		// 쓰다 멈춘 마지막 기록이다. 확정되지 않았으므로 버리고 그 자리부터 다시 쓴다.
		if err := f.Truncate(valid); err != nil {
			return err
		}
		if err := f.Sync(); err != nil {
			return err
		}
		q.used -= s.size - valid
		q.cut += s.size - valid
		s.size = valid
	}
	return nil
}

func checkMagic(r io.Reader) error {
	b := make([]byte, len(segMagic))
	if _, err := io.ReadFull(r, b); err != nil {
		return ErrCorrupt
	}
	if string(b) != segMagic {
		return ErrUnsupportedFormat
	}
	return nil
}

var errTorn = errors.New("queue: torn record")

// scan은 off 위치부터 기록을 차례로 읽어 fn을 부른다. 끝까지 온전하면 끝 위치와 nil을,
// 중간에 끊기거나 CRC가 맞지 않으면 마지막 온전한 기록의 끝 위치와 errTorn을 돌려준다.
func scan(r *bufio.Reader, off int64, fn func(off int64, seq uint64, payload []byte) error) (int64, error) {
	var h [frameHeader]byte
	for {
		if _, err := io.ReadFull(r, h[:]); err != nil {
			if errors.Is(err, io.EOF) {
				return off, nil
			}
			return off, errTorn
		}
		n := binary.BigEndian.Uint32(h[0:4])
		if n > maxPayload {
			return off, errTorn
		}
		payload := make([]byte, n)
		if _, err := io.ReadFull(r, payload); err != nil {
			return off, errTorn
		}
		crc := crc32.Update(0, castagnoli, h[8:16])
		crc = crc32.Update(crc, castagnoli, payload)
		if crc != binary.BigEndian.Uint32(h[4:8]) {
			return off, errTorn
		}
		if err := fn(off, binary.BigEndian.Uint64(h[8:16]), payload); err != nil {
			return off, err
		}
		off += frameHeader + int64(n)
	}
}

func appendFrame(buf []byte, seq uint64, payload []byte) []byte {
	var h [frameHeader]byte
	binary.BigEndian.PutUint32(h[0:4], uint32(len(payload)))
	binary.BigEndian.PutUint64(h[8:16], seq)
	crc := crc32.Update(0, castagnoli, h[8:16])
	crc = crc32.Update(crc, castagnoli, payload)
	binary.BigEndian.PutUint32(h[4:8], crc)
	return append(append(buf, h[:]...), payload...)
}

// Append는 기록들에 다음 순번부터 차례로 붙여 쓰고 디스크에 확정한다. 첫 기록의 순번을
// 돌려준다. nil 오류로 돌아온 뒤에만 기록이 확정된 것이다.
func (q *Queue) Append(payloads [][]byte) (uint64, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	first := q.next
	if len(payloads) == 0 {
		return first, nil
	}
	for _, p := range payloads {
		if len(p) > maxPayload {
			return 0, fmt.Errorf("queue: record of %d bytes is over %d", len(p), maxPayload)
		}
	}
	if err := q.ensureSegment(); err != nil {
		return 0, err
	}
	s := q.segs[len(q.segs)-1]
	var buf []byte
	off := s.size
	lastOff := s.lastOff
	for i, p := range payloads {
		lastOff = off + int64(len(buf))
		buf = appendFrame(buf, first+uint64(i), p)
	}
	if _, err := q.cur.Write(buf); err != nil {
		// 일부만 쓰였을 수 있다. 확정된 끝으로 되돌려 다음 쓰기가 깨진 기록 뒤에 붙지 않게 한다.
		_ = q.cur.Truncate(s.size)
		return 0, err
	}
	if err := q.cur.Sync(); err != nil {
		_ = q.cur.Truncate(s.size)
		return 0, err
	}
	s.size += int64(len(buf))
	s.last = first + uint64(len(payloads)) - 1
	s.lastOff = lastOff
	q.used += int64(len(buf))
	q.next = s.last + 1
	return first, nil
}

// ensureSegment는 이어 쓸 세그먼트를 연다. 마지막 세그먼트가 가득 찼으면 새로 만든다.
func (q *Queue) ensureSegment() error {
	if n := len(q.segs); n > 0 && q.segs[n-1].size < q.opt.SegmentBytes {
		if q.cur != nil {
			return nil
		}
		f, err := os.OpenFile(q.segs[n-1].path, os.O_WRONLY|os.O_APPEND, 0)
		if err != nil {
			return err
		}
		q.cur = f
		return nil
	}
	if q.cur != nil {
		if err := q.cur.Close(); err != nil {
			return err
		}
		q.cur = nil
	}
	s := &segment{path: filepath.Join(q.dir, segName(q.next)), first: q.next, last: q.next - 1}
	f, err := os.OpenFile(s.path, os.O_WRONLY|os.O_CREATE|os.O_EXCL|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.WriteString(segMagic); err != nil {
		f.Close()
		os.Remove(s.path)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(s.path)
		return err
	}
	if err := syncDir(q.dir); err != nil {
		f.Close()
		return err
	}
	s.size = int64(len(segMagic))
	q.used += s.size
	q.segs = append(q.segs, s)
	q.cur = f
	return nil
}

// Read는 from 순번부터 기록을 돌려준다. maxBytes(기록 본문 합계)나 maxCount에 닿으면
// 멈추되, 첫 기록은 크기와 상관없이 하나는 돌려준다.
func (q *Queue) Read(from uint64, maxBytes int, maxCount int) ([]Entry, error) {
	q.mu.Lock()
	var segs []segment
	for _, s := range q.segs {
		if s.last >= from && s.last >= s.first {
			segs = append(segs, *s) // 확정된 크기를 함께 복사해 잠금 밖에서 읽는다
		}
	}
	q.mu.Unlock()

	var out []Entry
	total := 0
	for _, s := range segs {
		done, err := readSegment(s, from, func(e Entry) bool {
			if len(out) > 0 && (total+len(e.Payload) > maxBytes || len(out) >= maxCount) {
				return false
			}
			out = append(out, e)
			total += len(e.Payload)
			return true
		})
		if err != nil {
			return out, err
		}
		if done {
			break
		}
	}
	return out, nil
}

// readSegment는 세그먼트에서 from 이상인 기록을 확정된 크기까지 읽는다. take가 false를
// 돌려주면 멈추고 done을 참으로 돌려준다.
func readSegment(s segment, from uint64, take func(Entry) bool) (done bool, err error) {
	f, err := os.Open(s.path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	r := bufio.NewReader(io.LimitReader(f, s.size))
	if err := checkMagic(r); err != nil {
		return false, fmt.Errorf("%s: %w", s.path, err)
	}
	stop := errors.New("stop")
	end, err := scan(r, int64(len(segMagic)), func(_ int64, seq uint64, payload []byte) error {
		if seq < from {
			return nil
		}
		if !take(Entry{Seq: seq, Payload: payload}) {
			return stop
		}
		return nil
	})
	switch {
	case errors.Is(err, stop):
		return true, nil
	case err != nil || end != s.size:
		// 확정된 범위 안의 기록이 깨졌다. 지우지 않고 알린다.
		return false, fmt.Errorf("%s at %d: %w", s.path, end, ErrCorrupt)
	}
	return false, nil
}

// Ack는 수신 서버가 through 순번까지 받았다고 기록하고, 다 받은 세그먼트를 지운다.
// 마지막 세그먼트는 남긴다. 거기 든 마지막 기록이 재시작 위치를 갖고 있기 때문이다.
func (q *Queue) Ack(through uint64) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if through <= q.acked {
		return nil
	}
	if through >= q.next {
		return fmt.Errorf("ack %d, last %d: %w", through, q.next-1, ErrAckBeyondEnd)
	}
	if err := writeState(q.dir, stateData{Format: stateFormat, AckedThrough: through, Generation: q.gen}); err != nil {
		return err
	}
	q.acked = through
	return q.removeDone()
}

// removeDone은 지워도 되는 세그먼트를 지운다. 잠금을 쥔 채 부른다. 수신 확인된 기록만 지우고,
// 스냅샷을 쓰는 대기면 스냅샷에 든 기록까지만 지운다. 마지막 세그먼트는 남긴다.
func (q *Queue) removeDone() error {
	through := q.acked
	if q.opt.Snapshots {
		through = min(through, q.snapped)
	}
	keep := make([]*segment, 0, len(q.segs))
	removed := false
	for i, s := range q.segs {
		if i < len(q.segs)-1 && s.last <= through {
			if err := os.Remove(s.path); err != nil && !errors.Is(err, fs.ErrNotExist) {
				q.segs = append(keep, q.segs[i:]...) // 지우지 못한 세그먼트부터는 그대로 둔다
				return err
			}
			q.used -= s.size
			removed = true
			continue
		}
		keep = append(keep, s)
	}
	q.segs = keep
	if removed {
		return syncDir(q.dir)
	}
	return nil
}

// SaveSnapshot은 through 순번까지의 기록을 반영한 읽기 위치(data, JSON)를 디스크에 확정한다.
// 그 뒤로 through까지의 기록은 수신 확인되면 지울 수 있다. 재시작하면 Snapshot으로 읽고
// through 뒤 기록을 Read로 다시 읽어 위치를 되살린다.
func (q *Queue) SaveSnapshot(through uint64, data []byte) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if !q.opt.Snapshots {
		return errors.New("queue: snapshots are not enabled")
	}
	if through >= q.next || through < q.snapped {
		return fmt.Errorf("queue: snapshot through %d, last record %d, last snapshot %d", through, q.next-1, q.snapped)
	}
	b, err := json.Marshal(snapData{Format: snapFormat, Through: through, Data: data})
	if err != nil {
		return err
	}
	if err := writeAtomic(q.dir, snapFile, b); err != nil {
		return err
	}
	q.snapped = through
	return q.removeDone()
}

// Snapshot은 마지막으로 확정한 읽기 위치 스냅샷이다. 없으면 ok가 false다.
func (q *Queue) Snapshot() (through uint64, data []byte, ok bool, err error) {
	b, err := os.ReadFile(filepath.Join(q.dir, snapFile))
	if errors.Is(err, fs.ErrNotExist) {
		return 0, nil, false, nil
	}
	if err != nil {
		return 0, nil, false, err
	}
	var s snapData
	if err := json.Unmarshal(b, &s); err != nil {
		return 0, nil, false, fmt.Errorf("%s: %w", snapFile, ErrCorrupt)
	}
	if s.Format > snapFormat {
		return 0, nil, false, fmt.Errorf("%s format %d: %w", snapFile, s.Format, ErrUnsupportedFormat)
	}
	return s.Through, s.Data, true, nil
}

// Last는 가장 최근에 확정한 기록이다. 재시작 위치를 되살리는 데 쓴다.
func (q *Queue) Last() (Entry, bool, error) {
	q.mu.Lock()
	var s segment
	ok := len(q.segs) > 0
	if ok {
		s = *q.segs[len(q.segs)-1]
	}
	q.mu.Unlock()
	if !ok || s.last < s.first {
		return Entry{}, false, nil
	}
	f, err := os.Open(s.path)
	if err != nil {
		return Entry{}, false, err
	}
	defer f.Close()
	if _, err := f.Seek(s.lastOff, io.SeekStart); err != nil {
		return Entry{}, false, err
	}
	var e Entry
	_, err = scan(bufio.NewReader(io.LimitReader(f, s.size-s.lastOff)), s.lastOff, func(_ int64, seq uint64, payload []byte) error {
		e = Entry{Seq: seq, Payload: payload}
		return nil
	})
	if err != nil || e.Seq != s.last {
		return Entry{}, false, fmt.Errorf("%s: %w", s.path, ErrCorrupt)
	}
	return e, true, nil
}

// Generation은 수신 서버가 정해 준 세대 번호다. 0이면 아직 받지 못했다.
func (q *Queue) Generation() uint16 {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.gen
}

// SetGeneration은 수신 서버에서 받은 세대 번호를 디스크에 확정한다. 한 번 정한 번호는
// 바꾸지 않는다. 바꾸면 이미 보낸 순번이 다른 세대로 읽혀 섞이기 때문이다.
func (q *Queue) SetGeneration(g uint16) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if g == 0 || (q.gen != 0 && q.gen != g) {
		return fmt.Errorf("queue: generation %d, already %d", g, q.gen)
	}
	if q.gen == g {
		return nil
	}
	if err := writeState(q.dir, stateData{Format: stateFormat, AckedThrough: q.acked, Generation: g}); err != nil {
		return err
	}
	q.gen = g
	return nil
}

// AckedThrough는 수신 서버가 받았다고 확인한 마지막 순번이다.
func (q *Queue) AckedThrough() uint64 {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.acked
}

// NextSeq는 다음에 쓸 순번이다.
func (q *Queue) NextSeq() uint64 {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.next
}

// Used는 대기가 차지한 디스크 바이트다.
func (q *Queue) Used() int64 {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.used
}

// Unacked는 수신 확인되지 않은 기록이 든 세그먼트의 바이트다. 재시작 위치 때문에 남겨 둔
// 세그먼트가 모두 수신 확인됐으면 세지 않는다. 읽기를 멈추고 다시 시작하는 판단(D01)에 쓴다.
// Used로 판단하면, 한 번에 쓴 기록이 한도의 대부분을 차지한 세그먼트가 수신 확인된 뒤에도
// 마지막 세그먼트로 남아 읽기가 다시 시작되지 않는다.
func (q *Queue) Unacked() int64 {
	q.mu.Lock()
	defer q.mu.Unlock()
	n := q.used
	for _, s := range q.segs {
		if s.last >= s.first && s.last <= q.acked {
			n -= s.size
		}
	}
	return n
}

// Limit은 대기 한도다.
func (q *Queue) Limit() int64 { return q.opt.LimitBytes }

// Close는 이어 쓰던 파일을 닫는다.
func (q *Queue) Close() error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.cur == nil {
		return nil
	}
	err := q.cur.Close()
	q.cur = nil
	return err
}
