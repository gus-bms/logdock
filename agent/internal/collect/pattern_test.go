package collect

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/gus-bms/logdock/agent/internal/assemble"
	"github.com/gus-bms/logdock/agent/internal/queue"
	"github.com/gus-bms/logdock/agent/internal/record"
	"github.com/gus-bms/logdock/agent/internal/tail"
)

// tick은 시각을 볼 때마다 1ms씩 가는 시계다. Step마다 폴더를 훑고 스냅샷을 쓰게 한다.
type tick struct{ now time.Time }

func (c *tick) Now() time.Time {
	c.now = c.now.Add(time.Millisecond)
	return c.now
}

// penv는 실제 임시 폴더와 디스크 대기로 파일명 규칙 연결 하나를 돌린다.
type penv struct {
	t     *testing.T
	dir   string
	qdir  string
	clk   *tick
	opt   Options
	qopt  queue.Options
	store SnapshotStore // 시험이 바꿔 끼울 수 있다. nil이면 q
	q     *queue.Queue
	r     *PatternReader
	seen  uint64
	got   map[string][]string // 파일 이름별 "종류 내용"
}

func newPenv(t *testing.T, rule string) *penv {
	t.Helper()
	dir := t.TempDir()
	e := &penv{t: t, dir: filepath.Join(dir, "logs"), qdir: filepath.Join(dir, "queue"),
		clk: &tick{now: time.Date(2026, 11, 6, 0, 0, 0, 0, time.UTC)}, got: map[string][]string{}}
	if err := os.Mkdir(e.dir, 0o755); err != nil {
		t.Fatal(err)
	}
	e.opt = Options{
		Path:             filepath.Join(e.dir, rule),
		ConfigVersion:    1,
		Tail:             tail.Options{ScanInterval: time.Millisecond, Now: e.clk.Now},
		Assemble:         assemble.Options{Format: assemble.Text, Now: e.clk.Now},
		SnapshotInterval: time.Millisecond,
	}
	e.qopt = queue.Options{Snapshots: true}
	t.Cleanup(e.stop)
	return e
}

func (e *penv) open() {
	e.t.Helper()
	q, err := queue.Open(e.qdir, e.qopt)
	if err != nil {
		e.t.Fatalf("queue.Open: %v", err)
	}
	var s SnapshotStore = q
	if e.store != nil {
		s = e.store
	}
	r, err := NewPatternReader(s, e.opt)
	if err != nil {
		q.Close()
		e.t.Fatalf("NewPatternReader: %v", err)
	}
	e.q, e.r = q, r
}

// stop은 정상 중지다. 마지막 위치를 스냅샷으로 남긴다.
func (e *penv) stop() {
	if e.r != nil {
		e.r.Close()
		e.r = nil
	}
	if e.q != nil {
		e.q.Close()
		e.q = nil
	}
}

// crash는 마지막 스냅샷을 쓰지 못하고 멈춘 것과 같다.
func (e *penv) crash() {
	e.r.w.Close()
	e.q.Close()
	e.r, e.q = nil, nil
}

func (e *penv) create(name, s string) *os.File {
	e.t.Helper()
	f, err := os.OpenFile(filepath.Join(e.dir, name), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { f.Close() })
	e.write(f, s)
	return f
}

func (e *penv) write(f *os.File, s string) {
	e.t.Helper()
	if _, err := f.WriteString(s); err != nil {
		e.t.Fatal(err)
	}
}

func (e *penv) step() Status {
	e.t.Helper()
	st := e.r.Step()
	e.collect()
	return st
}

// collect는 새로 확정된 기록을 파일 이름별로 모은다.
func (e *penv) collect() {
	e.t.Helper()
	es, err := e.q.Read(e.seen+1, 1<<20, 100000)
	if err != nil {
		e.t.Fatalf("Read: %v", err)
	}
	for _, en := range es {
		s, err := record.Decode(en.Payload)
		if err != nil {
			e.t.Fatal(err)
		}
		name := filepath.Base(s.Stream.Path)
		switch {
		case s.Boundary != nil:
			e.got[name] = append(e.got[name], "boundary "+s.Boundary.Kind)
		case s.Body != nil:
			e.got[name] = append(e.got[name], "event "+*s.Body)
		default:
			e.got[name] = append(e.got[name], s.Kind)
		}
		e.seen = en.Seq
	}
}

func (e *penv) expect(name string, want ...string) {
	e.t.Helper()
	if got := e.got[name]; !slices.Equal(got, want) {
		e.t.Fatalf("%s: got %q\nwant %q", name, got, want)
	}
}

func TestPatternReaderReadsEachFileOnItsOwn(t *testing.T) {
	e := newPenv(t, "*.log")
	a := e.create("a.log", "a-old\n")
	e.create("skip.txt", "not matched\n")
	e.open()
	e.step()
	e.write(a, "a1\n")
	b := e.create("b.log", "b1\nb2-start ")
	e.step()
	e.write(b, "end\n")
	e.write(a, "a2\n")
	if st := e.step(); st.State != Running {
		t.Fatalf("status %+v", st)
	}
	e.expect("a.log", "boundary initial_tail", "event a1", "event a2")
	e.expect("b.log", "boundary new_file_head", "event b1", "event b2-start end")
	if _, ok := e.got["skip.txt"]; ok {
		t.Fatal("file outside the rule was read")
	}
}

func TestPatternReaderRestartContinuesEveryFile(t *testing.T) {
	e := newPenv(t, "*.log")
	a := e.create("a.log", "")
	b := e.create("b.log", "")
	e.open()
	e.step()
	e.write(a, "a1\n")
	e.write(b, "b1\n")
	e.step()
	e.stop()
	e.write(a, "a2\n") // 꺼져 있던 사이 쓰였다
	c := e.create("c.log", "c1\n")
	e.open()
	e.step()
	e.write(c, "c2\n")
	e.step()
	e.expect("a.log", "boundary initial_tail", "event a1", "event a2")
	e.expect("b.log", "boundary initial_tail", "event b1")
	// 같은 규칙으로 다시 시작했으므로 상태에 없는 파일은 마지막으로 폴더를 본 뒤에 생겼다.
	e.expect("c.log", "boundary new_file_head", "event c1", "event c2")
}

func TestPatternReaderQuietFileKeepsItsPositionAfterAckedRecordsAreDeleted(t *testing.T) {
	e := newPenv(t, "*.log")
	e.qopt.SegmentBytes = 256
	a := e.create("a.log", "")
	b := e.create("b.log", "")
	e.open()
	e.step()
	e.write(a, "a1\n") // 이 기록 하나만 a의 위치를 갖고 있다
	e.step()
	for i := range 40 {
		e.write(b, fmt.Sprintf("b%02d\n", i))
		e.step()
	}
	if err := e.q.Ack(e.q.NextSeq() - 1); err != nil {
		t.Fatal(err)
	}
	e.step() // 스냅샷을 써서 수신 확인된 기록을 지울 수 있게 한다
	segs, _ := filepath.Glob(filepath.Join(e.qdir, "seg-*.dat"))
	if len(segs) > 1 {
		t.Fatalf("%d segments left, want acked ones deleted to make the case", len(segs))
	}
	e.crash()
	e.write(a, "a2\n")
	e.open()
	e.step()
	e.expect("a.log", "boundary initial_tail", "event a1", "event a2")
	if n := len(e.got["b.log"]); n != 41 {
		t.Fatalf("b has %d records, want 41", n)
	}
}

func TestPatternReaderRecoversFromRecordsAfterTheSnapshot(t *testing.T) {
	e := newPenv(t, "*.log")
	e.opt.SnapshotInterval = time.Hour
	a := e.create("a.log", "")
	e.open()
	e.step() // 첫 스냅샷
	e.write(a, "a1\nhalf")
	e.step()
	e.write(a, " line\n")
	e.step()
	through, _, ok, err := e.q.Snapshot()
	if err != nil || !ok || through >= e.q.NextSeq()-1 {
		t.Fatalf("snapshot through %d (ok %v, err %v), want behind the last record %d", through, ok, err, e.q.NextSeq()-1)
	}
	e.crash()
	e.write(a, "a3\n")
	e.open()
	e.step()
	e.expect("a.log", "boundary initial_tail", "event a1", "event half line", "event a3")
}

func TestPatternReaderRuleChangeStartsNewlyMatchedFilesAtEnd(t *testing.T) {
	e := newPenv(t, "*.log")
	a := e.create("a.log", "")
	c := e.create("c.txt", "c-old\n")
	e.open()
	e.step()
	e.stop()
	e.write(a, "a1\n")
	e.opt.Path = filepath.Join(e.dir, "*")
	e.open()
	st := e.step()
	e.write(c, "c-new\n")
	e.step()
	e.expect("a.log", "boundary initial_tail", "event a1")
	// 바뀐 규칙에 새로 든 파일은 언제 생겼는지 모르므로 끝에서 시작하고 건너뛴 크기를 알린다.
	e.expect("c.txt", "boundary new_file_tail", "event c-new")
	if len(st.Loss) != 1 || st.Loss[0].Kind != "new_file_tail" || st.Loss[0].Offset != 0 || st.Loss[0].SkippedBytes != int64(len("c-old\n")) {
		t.Fatalf("loss %+v", st.Loss)
	}
}

func TestPatternReaderMissingFolderIsHeldUntilCreated(t *testing.T) {
	e := newPenv(t, "*.log")
	e.opt.Path = filepath.Join(e.dir, "later", "*.log")
	e.open()
	if st := e.step(); st.State != Held || st.Reason != ReasonPathMissing {
		t.Fatalf("status %+v", st)
	}
	if err := os.Mkdir(filepath.Join(e.dir, "later"), 0o755); err != nil {
		t.Fatal(err)
	}
	e.dir = filepath.Join(e.dir, "later")
	e.create("app.log", "first\n")
	if st := e.step(); st.State != Running {
		t.Fatalf("status %+v", st)
	}
	e.expect("app.log", "boundary new_file_head", "event first")
}

func TestPatternReaderLostPositionsHoldInsteadOfStartingOver(t *testing.T) {
	e := newPenv(t, "*.log")
	e.qopt.SegmentBytes = 128
	a := e.create("a.log", "")
	e.open()
	e.step()
	for i := range 10 {
		e.write(a, fmt.Sprintf("line %d\n", i))
		e.step()
	}
	if err := e.q.Ack(e.q.NextSeq() - 1); err != nil {
		t.Fatal(err)
	}
	e.step()
	e.stop()
	if err := os.Remove(filepath.Join(e.qdir, "positions.json")); err != nil {
		t.Fatal(err)
	}
	e.open()
	if st := e.step(); st.State != Held || st.Reason != ReasonRecoveryHold {
		t.Fatalf("status %+v, want recovery hold", st)
	}
}

// failingSnapshots는 스냅샷 쓰기가 실패하는 디스크를 흉내 낸다.
type failingSnapshots struct {
	*queue.Queue
	fail bool
}

func (f *failingSnapshots) SaveSnapshot(through uint64, data []byte) error {
	if f.fail {
		return errors.New("disk full")
	}
	return f.Queue.SaveSnapshot(through, data)
}

func TestPatternReaderStopsReadingWhilePositionsCannotBeSaved(t *testing.T) {
	e := newPenv(t, "*.log")
	a := e.create("a.log", "")
	q, err := queue.Open(e.qdir, e.qopt)
	if err != nil {
		t.Fatal(err)
	}
	fs := &failingSnapshots{Queue: q, fail: true}
	r, err := NewPatternReader(fs, e.opt)
	if err != nil {
		t.Fatal(err)
	}
	e.q, e.r = q, r
	if st := e.step(); st.State != Failed || st.Reason != ReasonStateWriteFailed {
		t.Fatalf("status %+v", st)
	}
	e.write(a, "a1\n")
	e.step()
	if len(e.got["a.log"]) != 1 {
		t.Fatalf("read on while positions could not be saved: %q", e.got["a.log"])
	}
	fs.fail = false
	if st := e.step(); st.State != Running {
		t.Fatalf("status %+v", st)
	}
	e.expect("a.log", "boundary initial_tail", "event a1")
}

func TestPatternReaderFinishesLastLineWhenFileIsGone(t *testing.T) {
	e := newPenv(t, "*.log")
	e.open()
	e.step()
	e.create("a.log", "one\nno newline")
	e.step()
	if err := os.Remove(filepath.Join(e.dir, "a.log")); err != nil {
		t.Fatal(err)
	}
	e.step()
	e.clk.now = e.clk.now.Add(3 * time.Second) // 지워진 파일이 회전 유예만큼 조용했다
	e.step()
	e.expect("a.log", "boundary new_file_head", "event one", "event no newline")
}

func TestPatternReaderStoppedBeforeFirstSnapshotTreatsUnknownFilesAsUncertain(t *testing.T) {
	e := newPenv(t, "*.log")
	a := e.create("a.log", "")
	e.store = &failingSnapshots{fail: true} // 첫 스냅샷을 쓰지 못한다
	q, err := queue.Open(e.qdir, e.qopt)
	if err != nil {
		t.Fatal(err)
	}
	e.store.(*failingSnapshots).Queue = q
	r, err := NewPatternReader(e.store, e.opt)
	if err != nil {
		t.Fatal(err)
	}
	e.q, e.r = q, r
	e.step() // 최초 경계는 대기에 들어갔지만 스냅샷은 없다
	e.crash()
	e.store = nil
	e.write(a, "a1\n")
	b := e.create("b.log", "b-old\n")
	e.open()
	e.step()
	e.write(b, "b1\n")
	e.step()
	e.expect("a.log", "boundary initial_tail", "event a1")
	e.expect("b.log", "boundary new_file_tail", "event b1")
}
