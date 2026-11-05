// Package tail은 로그 파일 경로 하나를 따라가며 새로 붙은 바이트를 돌려준다.
//
// 이름 바꾸기 회전, copytruncate, 삭제를 겪어도 같은 바이트를 두 번 내거나 말없이 빠뜨리지
// 않는다. 빠뜨릴 수밖에 없는 구간은 경계(Chunk.Boundary)로 알린다.
//
// inotify·kqueue 대신 주기적인 stat으로 확인한다. Linux와 macOS에서 같은 코드가 돌고,
// Poll 한 번의 비용이 stat 몇 번과 읽은 바이트(Options.MaxReadBytes 이하)로 묶여 자원
// 상한을 잡기 쉽기 때문이다.
package tail

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// BoundaryKind는 계약 초안 2.3절의 경계 종류와 같은 값이다.
type BoundaryKind string

const (
	InitialTail    BoundaryKind = "initial_tail"     // 최초 연결: 이미 있던 파일의 끝에서 시작
	NewFileHead    BoundaryKind = "new_file_head"    // 연결 뒤 생긴 파일: 처음부터
	Rotated        BoundaryKind = "rotated"          // 경로가 다음 파일을 가리키게 됨
	Truncated      BoundaryKind = "truncated"        // 같은 파일이 잘렸거나(copytruncate) 처음부터 다시 쓰임
	IdentityReused BoundaryKind = "identity_reused"  // 장치·inode는 같지만 다른 파일: 새 파일로 본다
	GoneBeforeRead BoundaryKind = "gone_before_read" // 다 읽기 전에 파일이 사라짐
)

// Unknown은 잴 수 없었던 바이트 수다. 0으로 바꿔 보고하지 않는다.
const Unknown int64 = -1

// readBlock은 ReadAt 한 번에 읽는 크기다.
const readBlock = 64 << 10

var (
	// ErrNotRegular는 경로가 일반 파일이 아닐 때 돌려준다(디렉터리, 장치 파일 등).
	ErrNotRegular = errors.New("tail: not a regular file")
	errNoFileID   = errors.New("tail: cannot read device and inode")
)

// FileID는 장치와 inode 번호로 파일을 가리킨다. 경로와 달리 이름을 바꿔도 그대로라,
// 회전으로 밀려난 파일과 그 이름을 이어받은 새 파일을 구분할 수 있다.
type FileID struct {
	Dev uint64
	Ino uint64
}

// String은 계약의 file_id로 쓰는 값이다.
func (id FileID) String() string { return fmt.Sprintf("f_%x_%x", id.Dev, id.Ino) }

// Chunk는 파일에서 읽은 바이트(Data가 있음)이거나 경계(Boundary가 있음)다.
type Chunk struct {
	File   FileID
	Offset int64  // Data[0]의 파일 위치. 경계면 경계가 놓인 위치
	Data   []byte // 경계면 nil

	Boundary       BoundaryKind
	PrevFile       FileID // Rotated: 다 읽고 넘어온 앞 파일
	OrderConfirmed bool   // Rotated: 앞 파일이 이 경로를 떠나는 것을 직접 봐서 순서를 안다
	AtLineStart    bool   // InitialTail: 시작 위치 바로 앞이 줄바꿈이거나 파일 처음이다
	SkippedBytes   int64  // GoneBeforeRead·Truncated·IdentityReused: 잃은 바이트 수. 모르면 Unknown
}

// Options의 기본값은 시제품용이다. 제품 수치는 측정(M7) 뒤 정한다.
type Options struct {
	// MaxReadBytes는 Poll 한 번에 읽는 최대 바이트다. 쏟아지는 로그 하나가 읽기 예산을
	// 독차지하지 않게 한다.
	MaxReadBytes int
	// RotateGrace는 경로가 새 파일로 바뀐 뒤 옛 파일이 이만큼 조용해야 넘어간다는 뜻이다.
	// 앱은 로그를 다시 열기 전까지 옛 파일에 계속 쓰는 일이 흔하다.
	RotateGrace time.Duration
	// MaxHoldDeleted는 지워진 파일을 열어 두는 최대 시간이다. 열어 두는 동안 그 파일의
	// 디스크 공간이 돌아오지 않으므로, 이 시간이 지나면 덜 읽었어도 닫는다.
	MaxHoldDeleted time.Duration
	// MaxPending은 아직 읽을 차례가 아닌 다음 파일을 미리 열어 두는 최대 개수다.
	// 미리 열어 두면 그 파일이 또 회전돼 이름이 바뀌어도 놓치지 않는다.
	MaxPending int
	// FingerprintBytes는 제자리에서 다시 쓰인 파일을 알아보려고 기억하는 파일 앞부분 크기다.
	// 크기만 보면 잘린 뒤 빨리 커진 파일을 놓친다.
	FingerprintBytes int
	// Now는 지금 시각을 돌려준다. 시험에서 바꿔 끼운다.
	Now func() time.Time
}

func (o *Options) setDefaults() {
	if o.MaxReadBytes <= 0 {
		o.MaxReadBytes = 1 << 20
	}
	if o.RotateGrace <= 0 {
		o.RotateGrace = 2 * time.Second
	}
	if o.MaxHoldDeleted <= 0 {
		o.MaxHoldDeleted = 5 * time.Minute
	}
	if o.MaxPending <= 0 {
		o.MaxPending = 4
	}
	if o.FingerprintBytes <= 0 {
		o.FingerprintBytes = 256
	}
	if o.Now == nil {
		o.Now = time.Now
	}
}

// Position은 재시작 뒤 이어 읽는 데 필요한 값이다.
type Position struct {
	File   FileID
	Offset int64
	// HeadLen·HeadSum은 파일 앞부분의 길이와 sha256이다. inode 번호가 다른 파일에 다시
	// 쓰였는지 가린다. 로그 본문을 상태 파일에 남기지 않으려고 원문 대신 해시를 둔다.
	HeadLen int
	HeadSum [sha256.Size]byte
	// Gone은 이 파일이 사라졌다고 이미 알렸다는 뜻이다. 재시작 뒤 다시 찾거나 다시 알리지
	// 않고, 경로에 있는 파일을 그 다음 파일로 읽는다.
	Gone bool
}

// head는 파일 앞부분의 길이와 해시다.
type head struct {
	n   int
	sum [sha256.Size]byte
}

// maxClosedHeads는 닫은 파일의 앞부분 해시를 기억하는 개수다. 방금 닫은 파일의 기록에도
// 재시작 위치를 붙일 수 있게 몇 개만 남긴다.
const maxClosedHeads = 8

// tracked는 열어 둔 파일 하나의 읽기 상태다.
type tracked struct {
	f          *os.File
	id         FileID
	offset     int64
	head       []byte // 파일 앞부분. 다시 쓰였는지 비교하는 데 쓴다
	lastSize   int64
	lastDataAt time.Time
	deletedAt  time.Time
}

// Follower는 경로 하나를 따라 읽는다. 한 고루틴에서만 쓴다.
type Follower struct {
	path string
	opt  Options

	started bool
	restore *Position

	cur     *tracked
	pending []*tracked // 경로에서 본 다음 파일들. cur를 다 읽으면 이 순서로 넘어간다
	moved   bool       // 경로가 더 이상 cur를 가리키지 않는다
	// confirmOrder는 cur에서 다음 파일로 넘어갈 때의 Rotated.OrderConfirmed 값이다.
	// 재시작 뒤 디렉터리에서 다시 찾은 파일은 회전을 직접 보지 않았으므로 false다.
	confirmOrder bool
	// pendingFull은 미리 열 자리가 없어 다음 파일 하나를 열지 못했다는 뜻이다.
	// 그 사이 파일을 놓쳤을 수 있으므로 다음 Rotated는 순서를 확인하지 않은 것으로 낸다.
	pendingFull bool

	// cur 없이 기다리는 동안, 다음에 경로에 나타날 파일이 이어받는 앞 파일
	prev        FileID
	havePrev    bool
	prevConfirm bool

	closed map[FileID]head // 최근에 닫은 파일의 앞부분 해시
}

// New는 path를 따라 읽는 Follower를 만든다. 첫 Poll 전에는 파일을 열지 않는다.
func New(path string, opt Options) *Follower {
	opt.setDefaults()
	return &Follower{path: path, opt: opt}
}

// Restore는 첫 Poll 전에 저장해 둔 위치를 넘겨 재시작 뒤 이어 읽게 한다.
// 부르지 않으면 최초 연결로 보고 파일 끝에서 시작한다(D02).
func (t *Follower) Restore(p Position) { t.restore = &p }

// Position은 지금 읽고 있는 파일과 읽은 위치다. 연 파일이 없으면 ok가 false다.
// 이벤트를 대기에 확정한 위치까지만 저장해야 하므로(AG-12), 부르는 쪽이 Offset을
// 확정한 위치로 바꿔 저장할 수 있다.
func (t *Follower) Position() (p Position, ok bool) {
	if t.cur == nil {
		return Position{}, false
	}
	c := t.cur
	return Position{File: c.id, Offset: c.offset, HeadLen: len(c.head), HeadSum: sha256.Sum256(c.head)}, true
}

// Head는 id 파일의 앞부분 길이와 해시다. 기록마다 재시작 위치를 저장할 때 함께 둔다.
// 지금 읽는 파일, 미리 연 파일, 최근에 닫은 파일만 안다.
func (t *Follower) Head(id FileID) (n int, sum [sha256.Size]byte, ok bool) {
	if t.cur != nil && t.cur.id == id {
		return len(t.cur.head), sha256.Sum256(t.cur.head), true
	}
	for _, p := range t.pending {
		if p.id == id {
			return len(p.head), sha256.Sum256(p.head), true
		}
	}
	if h, ok := t.closed[id]; ok {
		return h.n, h.sum, true
	}
	return 0, sum, false
}

// rememberHead는 닫는 파일의 앞부분 해시를 몇 개까지 남긴다.
func (t *Follower) rememberHead(c *tracked) {
	if t.closed == nil {
		t.closed = make(map[FileID]head)
	}
	if len(t.closed) >= maxClosedHeads {
		for id := range t.closed {
			delete(t.closed, id) // 아무거나 하나 비운다
			break
		}
	}
	t.closed[c.id] = head{n: len(c.head), sum: sha256.Sum256(c.head)}
}

// Close는 열어 둔 파일을 모두 닫는다.
func (t *Follower) Close() error {
	var errs []error
	if t.cur != nil {
		errs = append(errs, t.cur.f.Close())
		t.cur = nil
	}
	for _, p := range t.pending {
		errs = append(errs, p.f.Close())
	}
	t.pending = nil
	return errors.Join(errs...)
}

// Poll은 지난번 뒤로 붙은 바이트와 그 사이 생긴 경계를 순서대로 돌려준다.
// 오류가 나도 그때까지 모은 Chunk는 함께 돌려준다.
func (t *Follower) Poll() ([]Chunk, error) {
	var out []Chunk
	if !t.started {
		if err := t.start(&out); err != nil {
			return out, err
		}
		t.started = true
	}
	budget := t.opt.MaxReadBytes
	// 한 번의 Poll 안에서 여러 파일을 차례로 넘어갈 수 있다. 미리 연 파일 수만큼만 돈다.
	for range t.opt.MaxPending + 2 {
		if t.cur == nil {
			ok, err := t.adoptPath(&out)
			if err != nil || !ok {
				return out, err
			}
		}
		// 읽기 전에 잘림부터 본다. 잘린 뒤 다시 커진 파일을 옛 위치에서 읽으면 내용이 섞인다.
		if err := t.checkRewrite(&out); err != nil {
			return out, err
		}
		n, err := t.drain(&out, budget)
		if err != nil {
			return out, err
		}
		budget -= n
		again, err := t.checkPath(&out)
		if err != nil {
			return out, err
		}
		if !again || budget <= 0 {
			return out, nil
		}
	}
	return out, nil
}

// start는 첫 Poll에서 시작 위치를 정한다.
func (t *Follower) start(out *[]Chunk) error {
	if t.restore != nil {
		return t.resume(out, *t.restore)
	}
	f, fi, err := openRegular(t.path)
	if errors.Is(err, fs.ErrNotExist) {
		// 연결할 때 파일이 없었다. 나중에 생기는 파일은 연결 뒤에 만들어진 것이므로
		// 처음부터 읽는다(adoptPath).
		return nil
	}
	if err != nil {
		return err
	}
	c, err := t.track(f, fi, fi.Size())
	if err != nil {
		f.Close()
		return err
	}
	atLineStart, err := endsWithNewline(f, fi.Size())
	if err != nil {
		f.Close()
		return err
	}
	t.cur, t.confirmOrder = c, true
	*out = append(*out, Chunk{File: c.id, Offset: c.offset, Boundary: InitialTail, AtLineStart: atLineStart})
	return nil
}

// resume은 저장한 위치에서 이어 읽을 파일을 찾는다.
func (t *Follower) resume(out *[]Chunk, p Position) error {
	if p.Gone {
		// 사라졌다고 이미 알린 파일이다. 경로의 파일을 그 다음 파일로 읽는다(adoptPath).
		t.prev, t.havePrev, t.prevConfirm = p.File, true, false
		return nil
	}
	f, fi, err := openRegular(t.path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err == nil {
		c, err := t.track(f, fi, 0)
		if err != nil {
			f.Close()
			return err
		}
		if c.id == p.File {
			t.cur, t.confirmOrder = c, true
			same, err := sameHead(f, p)
			if err != nil {
				return err
			}
			switch {
			case !same:
				// inode 번호만 같고 다른 파일이다. 옛 파일의 남은 부분은 잃었고 크기는 모른다.
				*out = append(*out, Chunk{File: c.id, Boundary: IdentityReused, SkippedBytes: Unknown})
			case fi.Size() < p.Offset:
				*out = append(*out, Chunk{File: c.id, Boundary: Truncated, SkippedBytes: Unknown})
			default:
				c.offset = p.Offset
			}
			return nil
		}
		// 경로에는 다른 파일이 있다. 쉬는 동안 회전된 것이므로 옛 파일 다음에 읽는다.
		t.pending = append(t.pending, c)
	}
	old, err := t.findByID(filepath.Dir(t.path), p)
	if err != nil {
		return err
	}
	if old != nil {
		t.cur, t.moved, t.confirmOrder = old, true, false
		return nil
	}
	// 옛 파일을 찾지 못했다. 남은 부분을 잃었고 크기는 모른다.
	*out = append(*out, Chunk{File: p.File, Offset: p.Offset, Boundary: GoneBeforeRead, SkippedBytes: Unknown})
	if len(t.pending) > 0 {
		c := t.pending[0]
		t.pending = t.pending[1:]
		t.cur, t.confirmOrder = c, true
		*out = append(*out, Chunk{File: c.id, Boundary: Rotated, PrevFile: p.File, OrderConfirmed: false})
		return nil
	}
	t.prev, t.havePrev, t.prevConfirm = p.File, true, false
	return nil
}

// adoptPath는 연 파일이 없을 때 경로의 파일을 처음부터 읽기 시작한다.
func (t *Follower) adoptPath(out *[]Chunk) (bool, error) {
	f, fi, err := openRegular(t.path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	c, err := t.track(f, fi, 0)
	if err != nil {
		f.Close()
		return false, err
	}
	t.cur, t.moved, t.confirmOrder = c, false, true
	switch {
	case !t.havePrev:
		*out = append(*out, Chunk{File: c.id, Boundary: NewFileHead})
	case c.id == t.prev:
		// 지워진 앞 파일의 inode 번호를 새 파일이 이어받았다. 그래도 새 파일이다.
		*out = append(*out, Chunk{File: c.id, Boundary: IdentityReused, SkippedBytes: 0})
	default:
		*out = append(*out, Chunk{File: c.id, Boundary: Rotated, PrevFile: t.prev, OrderConfirmed: t.prevConfirm})
	}
	t.havePrev = false
	return true, nil
}

// checkRewrite는 cur가 잘렸거나(copytruncate) 처음부터 다시 쓰였는지 본다.
func (t *Follower) checkRewrite(out *[]Chunk) error {
	c := t.cur
	fi, err := c.f.Stat()
	if err != nil {
		return err
	}
	size := fi.Size()
	if size == c.lastSize {
		return nil
	}
	rewritten := size < c.offset
	if !rewritten {
		if rewritten, err = c.headChanged(size, t.opt.FingerprintBytes); err != nil {
			return err
		}
	}
	c.lastSize = size
	if !rewritten {
		return nil
	}
	// 잘리기 직전에 쓰였지만 아직 읽지 못한 바이트는 잃었다. 얼마인지는 모른다.
	*out = append(*out, Chunk{File: c.id, Offset: 0, Boundary: Truncated, SkippedBytes: Unknown})
	c.offset = 0
	return c.loadHead(size, t.opt.FingerprintBytes)
}

// drain은 cur에서 budget 바이트까지 읽는다.
func (t *Follower) drain(out *[]Chunk, budget int) (int, error) {
	c := t.cur
	read := 0
	for read < budget {
		buf := make([]byte, min(budget-read, readBlock))
		n, err := c.f.ReadAt(buf, c.offset)
		if n > 0 {
			*out = append(*out, Chunk{File: c.id, Offset: c.offset, Data: buf[:n]})
			c.offset += int64(n)
			read += n
			c.lastDataAt = t.opt.Now()
		}
		if errors.Is(err, io.EOF) || n == 0 {
			return read, nil
		}
		if err != nil {
			return read, err
		}
	}
	return read, nil
}

// checkPath는 경로가 아직 cur를 가리키는지 보고, 다른 파일로 넘어갔으면 cur를 다 읽은 뒤
// 다음 파일로 옮긴다. again이 true면 같은 Poll에서 한 번 더 읽어 볼 만하다.
func (t *Follower) checkPath(out *[]Chunk) (again bool, err error) {
	fi, err := os.Stat(t.path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		t.moved = true
	case err != nil:
		return false, err
	default:
		id, ok := fileIDOf(fi)
		if !ok {
			return false, errNoFileID
		}
		switch {
		case id == t.cur.id:
			t.moved = false
		case t.isPending(id):
			t.moved = true
		default:
			t.moved = true
			if err := t.openPending(); err != nil {
				return false, err
			}
		}
	}
	if !t.moved {
		return false, nil
	}
	return t.leaveIfDone(out)
}

// leaveIfDone은 경로를 떠난 cur를 다 읽었으면 다음 파일로 옮기거나 닫는다.
func (t *Follower) leaveIfDone(out *[]Chunk) (bool, error) {
	c := t.cur
	fi, err := c.f.Stat()
	if err != nil {
		return false, err
	}
	now := t.opt.Now()
	deleted := linkCount(fi) == 0
	if deleted && c.deletedAt.IsZero() {
		c.deletedAt = now
	}
	atEOF := c.offset >= fi.Size()
	quiet := now.Sub(c.lastDataAt) >= t.opt.RotateGrace

	if deleted && !atEOF && now.Sub(c.deletedAt) >= t.opt.MaxHoldDeleted {
		// 디스크 공간을 돌려주려고 다 읽지 못한 채 닫는다. 남은 바이트는 잃은 것으로 알린다.
		*out = append(*out, Chunk{File: c.id, Offset: c.offset, Boundary: GoneBeforeRead, SkippedBytes: fi.Size() - c.offset})
		return true, t.next(out)
	}
	if !atEOF || !quiet {
		return false, nil // 앱이 아직 옛 파일에 쓰고 있을 수 있다
	}
	if len(t.pending) == 0 && !deleted {
		// 이름만 바뀌었고 다음 파일은 아직 없다. 앱이 계속 쓸 수 있으니 열어 둔다.
		return false, nil
	}
	return true, t.next(out)
}

// next는 cur를 닫고 미리 연 다음 파일로 넘어간다. 다음 파일이 없으면 경로에 새 파일이
// 생기기를 기다린다.
func (t *Follower) next(out *[]Chunk) error {
	old := t.cur
	confirm := t.confirmOrder && !t.pendingFull
	t.cur, t.pendingFull = nil, false
	t.rememberHead(old)
	if err := old.f.Close(); err != nil {
		return err
	}
	if len(t.pending) == 0 {
		t.prev, t.havePrev, t.prevConfirm = old.id, true, confirm
		return nil
	}
	c := t.pending[0]
	t.pending = t.pending[1:]
	t.cur, t.moved, t.confirmOrder = c, false, true
	*out = append(*out, Chunk{File: c.id, Offset: 0, Boundary: Rotated, PrevFile: old.id, OrderConfirmed: confirm})
	return nil
}

func (t *Follower) isPending(id FileID) bool {
	for _, p := range t.pending {
		if p.id == id {
			return true
		}
	}
	return false
}

// openPending은 경로에 새로 나타난 파일을 미리 열어 둔다. 읽기는 앞 파일을 다 읽은 뒤에 한다.
func (t *Follower) openPending() error {
	if len(t.pending) >= t.opt.MaxPending {
		t.pendingFull = true
		return nil
	}
	f, fi, err := openRegular(t.path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil // stat과 open 사이에 또 바뀌었다. 다음 Poll에서 다시 본다
	}
	if err != nil {
		return err
	}
	c, err := t.track(f, fi, 0)
	if err != nil {
		f.Close()
		return err
	}
	if c.id == t.cur.id || t.isPending(c.id) {
		return f.Close()
	}
	t.pending = append(t.pending, c)
	return nil
}

// findByID는 재시작 뒤 저장한 파일을 같은 폴더에서 inode 번호로 찾는다. 이름을 바꿔
// 회전된 파일은 보통 같은 폴더에 남는다.
func (t *Follower) findByID(dir string, p Position) (*tracked, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if !e.Type().IsRegular() {
			continue
		}
		name := filepath.Join(dir, e.Name())
		fi, err := os.Stat(name)
		if err != nil {
			continue // 그 사이 지워졌거나 권한이 없다
		}
		if id, ok := fileIDOf(fi); !ok || id != p.File {
			continue
		}
		f, fi, err := openRegular(name)
		if err != nil {
			return nil, err
		}
		if same, err := sameHead(f, p); err != nil || !same {
			f.Close()
			return nil, err // 같은 번호의 다른 파일이면 찾지 못한 것으로 본다
		}
		c, err := t.track(f, fi, min(p.Offset, fi.Size()))
		if err != nil {
			f.Close()
			return nil, err
		}
		return c, nil
	}
	return nil, nil
}

// track은 연 파일의 읽기 상태를 만든다.
func (t *Follower) track(f *os.File, fi os.FileInfo, offset int64) (*tracked, error) {
	id, ok := fileIDOf(fi)
	if !ok {
		return nil, errNoFileID
	}
	c := &tracked{f: f, id: id, offset: offset, lastSize: fi.Size()}
	if err := c.loadHead(fi.Size(), t.opt.FingerprintBytes); err != nil {
		return nil, err
	}
	return c, nil
}

// loadHead는 파일 앞부분을 기억한다.
func (c *tracked) loadHead(size int64, limit int) error {
	n := min(size, int64(limit))
	c.head = make([]byte, n)
	if n == 0 {
		return nil
	}
	_, err := c.f.ReadAt(c.head, 0)
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

// headChanged는 파일 앞부분이 기억한 것과 달라졌는지 본다. 잘린 뒤 이전 위치보다 더
// 커진 파일은 크기만으로 알 수 없어서 내용으로 확인한다.
func (c *tracked) headChanged(size int64, limit int) (bool, error) {
	n := min(size, int64(limit))
	buf := make([]byte, n)
	if n > 0 {
		if _, err := c.f.ReadAt(buf, 0); err != nil && !errors.Is(err, io.EOF) {
			return false, err
		}
	}
	common := min(len(c.head), len(buf))
	changed := !bytes.Equal(c.head[:common], buf[:common])
	c.head = buf
	return changed, nil
}

// sameHead는 저장한 앞부분 해시와 지금 파일 앞부분이 같은지 본다.
func sameHead(f *os.File, p Position) (bool, error) {
	if p.HeadLen == 0 {
		return true, nil
	}
	buf := make([]byte, p.HeadLen)
	n, err := f.ReadAt(buf, 0)
	if err != nil && !errors.Is(err, io.EOF) {
		return false, err
	}
	if n < p.HeadLen {
		return false, nil
	}
	return sha256.Sum256(buf) == p.HeadSum, nil
}

// openRegular는 일반 파일만 연다. 상태는 연 파일 기준으로 다시 읽는다(stat과 open 사이에
// 경로가 바뀔 수 있으므로).
func openRegular(path string) (*os.File, os.FileInfo, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	if !fi.Mode().IsRegular() {
		f.Close()
		return nil, nil, fmt.Errorf("%s: %w", path, ErrNotRegular)
	}
	return f, fi, nil
}

// endsWithNewline은 size 위치 바로 앞 바이트가 줄바꿈인지 본다. 빈 파일이면 true다.
func endsWithNewline(f *os.File, size int64) (bool, error) {
	if size == 0 {
		return true, nil
	}
	b := make([]byte, 1)
	if _, err := f.ReadAt(b, size-1); err != nil && !errors.Is(err, io.EOF) {
		return false, err
	}
	return b[0] == '\n', nil
}
