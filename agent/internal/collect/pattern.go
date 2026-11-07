package collect

import (
	"cmp"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"
	"time"

	"github.com/gus-bms/logdock/agent/internal/assemble"
	"github.com/gus-bms/logdock/agent/internal/queue"
	"github.com/gus-bms/logdock/agent/internal/record"
	"github.com/gus-bms/logdock/agent/internal/tail"
)

// snapshotFormat은 PatternReader가 대기 폴더에 저장하는 읽기 위치 스냅샷의 형식 버전이다.
const snapshotFormat = 1

// SnapshotStore는 PatternReader가 쓰는 대기 기능이다(queue.Options.Snapshots를 켠 대기).
type SnapshotStore interface {
	Store
	Read(from uint64, maxBytes int, maxCount int) ([]queue.Entry, error)
	SaveSnapshot(through uint64, data []byte) error
	Snapshot() (through uint64, data []byte, ok bool, err error)
}

// PatternReader는 파일명 규칙에 맞는 여러 파일을 따라 읽는 연결 하나다(file_pattern, Q02-06).
// 한 고루틴에서만 쓴다.
//
// 파일 하나를 읽는 Reader는 마지막 기록에 든 "다음 위치" 하나로 재시작한다. 파일이 여럿이면
// 그것으로 모자라다. 한동안 조용한 파일의 위치가 든 기록은 수신 확인 뒤 지워질 수 있기 때문이다.
// 그래서 모든 파일의 위치를 스냅샷으로 대기 폴더에 따로 확정하고, 대기는 스냅샷 뒤 기록을
// 지우지 않는다. 재시작하면 스냅샷을 읽고 그 뒤 기록을 차례로 다시 읽어 파일마다 마지막으로
// 확정된 위치를 되살린다. 기록이 위치를 확정한다는 원칙(AG-12)은 그대로이고, 스냅샷은 다시 읽을
// 기록을 줄이는 요약이다.
type PatternReader struct {
	base
	store SnapshotStore
	w     *tail.Watcher
	asm   map[tail.FileID]*assemble.Assembler // 파일마다 따로 묶는다. 파일 사이를 섞지 않는다(AG-08)
	hold  bool                                // 복구 보류(Q06)

	lastSnap time.Time
	unsaved  bool // 스냅샷 뒤에 대기에 쓴 기록이 있거나 아직 스냅샷이 없다
}

// snapshot은 스냅샷의 내용이다.
type snapshot struct {
	Format int    `json:"format"`
	Rule   string `json:"rule"` // 만들 때의 파일명 규칙
	// Unsure는 폴더에서 봤지만 따라가지 못한 파일(한도, 열기 오류)이 있었다는 뜻이다.
	Unsure bool        `json:"unsure,omitempty"`
	Files  []snapEntry `json:"files"`
}

// snapEntry는 파일 하나의 재시작 위치다. 위치 값은 대기 기록에 붙이는 것과 같은 형식이다.
type snapEntry struct {
	record.Checkpoint
	Name string `json:"name"`
	Size int64  `json:"size"` // 마지막으로 본 크기
}

// fileState는 재시작 때 되살리는 파일 하나의 상태다.
type fileState struct {
	cp   record.Checkpoint
	name string
	size int64
}

// NewPatternReader는 스냅샷과 그 뒤 대기 기록에서 파일마다 재시작 위치를 되살려 PatternReader를
// 만든다. 둘 다 없으면 최초 연결로 보고 이미 있는 파일은 끝에서 시작한다(D02).
func NewPatternReader(store SnapshotStore, opt Options) (*PatternReader, error) {
	opt.setDefaults()
	r := &PatternReader{
		base:  base{opt: opt, store: store},
		store: store,
		w:     tail.NewWatcher(opt.Path, opt.Tail),
		asm:   map[tail.FileID]*assemble.Assembler{},
	}
	r.status = Status{State: Running, RejectedSince: r.asmNow(), RejectedLimit: opt.Assemble.MaxEventBytes}
	res, ok, err := r.restore()
	if err != nil {
		return nil, err
	}
	if !ok {
		// 전에 쓴 기록이 있는데 파일 위치를 되살릴 근거가 사라졌다. 끝부터 새로 시작하면 그 사이
		// 로그를 말없이 건너뛰므로, 읽지 않고 복구 보류로 둔다(D02 복구 상태 유실, Q06).
		r.status = Status{State: Held, Reason: ReasonRecoveryHold}
		r.hold = true
		return r, nil
	}
	r.unsaved = true // 처음 폴더를 본 뒤 스냅샷을 써 둔다. 최초 시작 위치도 확정해야 한다
	if res == nil {
		return r, nil
	}
	r.w.Restore(res.Resume)
	for i, f := range res.Files {
		a := assemble.New(opt.Assemble)
		a.Restore(res.cps[i])
		r.asm[f.File] = a
	}
	return r, nil
}

// restore는 스냅샷을 읽고 그 뒤 기록으로 파일 상태를 되살린다. 처음 연결하면 res가 nil이고,
// 되살릴 근거가 사라졌으면 ok가 false다.
func (r *PatternReader) restore() (res *resumeState, ok bool, err error) {
	through, data, haveSnap, err := r.store.Snapshot()
	if err != nil {
		return nil, false, err
	}
	next := r.store.NextSeq()
	if !haveSnap && next == 1 {
		return nil, true, nil
	}
	files := map[tail.FileID]*fileState{}
	var order []tail.FileID
	s := snapshot{Rule: r.opt.Path}
	if haveSnap {
		if err := json.Unmarshal(data, &s); err != nil {
			return nil, false, fmt.Errorf("read positions: %w", err)
		}
		if s.Format > snapshotFormat {
			return nil, false, fmt.Errorf("read positions format %d: %w", s.Format, queue.ErrUnsupportedFormat)
		}
		for _, e := range s.Files {
			id := tail.FileID{Dev: e.Dev, Ino: e.Ino}
			files[id] = &fileState{cp: e.Checkpoint, name: e.Name, size: e.Size}
			order = append(order, id)
		}
	}
	// 스냅샷 뒤 기록을 차례로 다시 읽는다. 기록마다 그 파일의 다음 위치가 들어 있다.
	for from := through + 1; from < next; {
		es, err := r.store.Read(from, 4<<20, 4096)
		if err != nil {
			return nil, false, err
		}
		if len(es) == 0 || es[0].Seq != from {
			return nil, false, nil // 스냅샷 뒤 기록이 사라졌다
		}
		for _, e := range es {
			st, err := record.Decode(e.Payload)
			if err != nil {
				return nil, false, err
			}
			id := tail.FileID{Dev: st.Checkpoint.Dev, Ino: st.Checkpoint.Ino}
			if st.Checkpoint.Gone {
				// 사라졌다고 이미 알린 파일이다. 다시 찾거나 다시 알리지 않는다.
				delete(files, id)
				order = slices.DeleteFunc(order, func(x tail.FileID) bool { return x == id })
				from = e.Seq + 1
				continue
			}
			f := files[id]
			if f == nil {
				f = &fileState{}
				files[id] = f
				order = append(order, id)
			}
			f.cp, f.size = st.Checkpoint, max(f.size, st.Checkpoint.Offset)
			if st.Stream.Path != "" {
				f.name = filepath.Base(st.Stream.Path)
			}
			from = e.Seq + 1
		}
	}
	// 스냅샷 없이 기록만 있으면 첫 스냅샷 전에 멈춘 것이다. 그때 따라가지 못한 파일이 있었는지
	// 모르므로, 상태에 없는 파일은 언제 생겼는지 모르는 파일로 보고 끝에서 시작한다.
	res = &resumeState{Resume: tail.Resume{SameRule: s.Rule == r.opt.Path, Unsure: s.Unsure || !haveSnap}}
	for _, id := range order {
		f := files[id]
		pos, acp, err := f.cp.Position()
		if err != nil {
			return nil, false, err
		}
		res.Files = append(res.Files, tail.Saved{Position: pos, Name: f.name, Size: f.size})
		res.cps = append(res.cps, acp)
	}
	return res, true, nil
}

// resumeState는 Watcher에 넘길 파일 상태와, 같은 순서로 조립기에 넘길 재시작 위치다.
type resumeState struct {
	tail.Resume
	cps []assemble.Checkpoint
}

// Status는 마지막 Step 뒤의 읽기 상태다.
func (r *PatternReader) Status() Status { return r.status }

// Close는 마지막 위치를 확정하고 열어 둔 원본 파일을 닫는다. 위치를 쓰지 못해도 대기 기록으로
// 되살릴 수 있다. 다음 시작이 다시 읽을 기록을 줄이려고 쓴다.
func (r *PatternReader) Close() error {
	if !r.hold && len(r.pending) == 0 && r.unsaved && r.w.Scanned() {
		r.saveSnapshot()
	}
	return r.w.Close()
}

// Step은 한 번 읽어 대기에 확정하고 읽기 상태를 돌려준다. 주기적으로 부른다.
func (r *PatternReader) Step() Status {
	if r.hold {
		return r.status
	}
	if len(r.pending) > 0 && !r.flush() {
		return r.status
	}
	if r.status.Reason == ReasonStateWriteFailed && !r.saveSnapshot() {
		return r.status // D05: 위치를 확정할 수 없으면 더 읽지 않는다
	}
	if r.queueFull() {
		r.status.State, r.status.Reason = Paused, ReasonQueueFull // D01
		return r.status
	}
	chunks, err := r.w.Poll()
	var recs []assemble.Record
	for _, c := range chunks {
		if c.Data != nil {
			r.status.LastReadAt = r.asmNow()
			r.status.ReadBytes += int64(len(c.Data))
		}
		a := r.asm[c.File]
		if a == nil {
			a = assemble.New(r.opt.Assemble)
			r.asm[c.File] = a
		}
		if c.End {
			recs = append(recs, a.End()...)
			delete(r.asm, c.File)
			continue
		}
		recs = append(recs, a.Push(c)...)
	}
	for _, id := range r.files() {
		recs = append(recs, r.asm[id].Tick()...)
	}
	for _, rec := range recs {
		b, encErr := record.Encode(rec, r.w.Path(rec.File), r.opt.ConfigVersion, r.w.Head)
		if encErr != nil {
			r.status.State, r.status.Reason = Held, ReasonReadError
			return r.status
		}
		r.pending = append(r.pending, b)
		r.note(rec)
	}
	if len(r.pending) > 0 {
		if !r.flush() {
			return r.status
		}
		r.unsaved = true
	}
	if r.unsaved && r.w.Scanned() && r.asmNow().Sub(r.lastSnap) >= r.opt.SnapshotInterval && !r.saveSnapshot() {
		return r.status
	}
	r.status.State, r.status.Reason = Running, ""
	switch {
	case err != nil:
		// 폴더가 없거나 파일 하나를 읽지 못했다. 읽을 수 있는 파일은 계속 읽는다.
		r.status.State, r.status.Reason = Held, readReason(err)
	case r.w.Limited():
		r.status.State, r.status.Reason = Paused, ReasonFileLimit
	}
	return r.status
}

// saveSnapshot은 모든 파일의 재시작 위치를 대기 폴더에 확정한다. 대기에 쓴 기록까지만 반영하도록
// 들고 있는 기록이 없을 때 부른다. 실패하면 상태를 failed로 두고 다음 Step에서 다시 쓴다.
func (r *PatternReader) saveSnapshot() bool {
	s := snapshot{Format: snapshotFormat, Rule: r.opt.Path, Unsure: r.w.Unsure(), Files: []snapEntry{}}
	for _, f := range r.w.Files() {
		cp := record.Checkpoint{Dev: f.File.Dev, Ino: f.File.Ino, Offset: f.Offset, HeadLen: f.HeadLen}
		if f.HeadLen > 0 {
			cp.HeadSum = hex.EncodeToString(f.HeadSum[:])
		}
		if a := r.asm[f.File]; a != nil {
			// 읽은 위치가 아니라 이벤트로 확정한 위치를 저장한다. 조립 중인 줄은 다시 읽는다(AG-12).
			acp := a.Checkpoint()
			cp.Offset, cp.SkipToLine, cp.WaitStart = acp.Offset, acp.SkipToLine, acp.WaitStart
		}
		s.Files = append(s.Files, snapEntry{Checkpoint: cp, Name: f.Name, Size: f.Size})
	}
	b, err := json.Marshal(s)
	if err == nil {
		err = r.store.SaveSnapshot(r.store.NextSeq()-1, b)
	}
	if err != nil {
		r.status.State, r.status.Reason = Failed, ReasonStateWriteFailed
		return false
	}
	r.lastSnap, r.unsaved = r.asmNow(), false
	if r.status.Reason == ReasonStateWriteFailed {
		r.status.State, r.status.Reason = Running, ""
	}
	return true
}

// files는 조립기를 가진 파일을 정해진 순서로 돌려준다. 같은 입력이면 기록 순서가 같게 한다.
func (r *PatternReader) files() []tail.FileID {
	ids := make([]tail.FileID, 0, len(r.asm))
	for id := range r.asm {
		ids = append(ids, id)
	}
	slices.SortFunc(ids, func(a, b tail.FileID) int {
		return cmp.Or(cmp.Compare(a.Dev, b.Dev), cmp.Compare(a.Ino, b.Ino))
	})
	return ids
}
