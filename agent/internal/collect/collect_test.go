package collect

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/gus-bms/logdock/agent/internal/assemble"
	"github.com/gus-bms/logdock/agent/internal/queue"
	"github.com/gus-bms/logdock/agent/internal/record"
	"github.com/gus-bms/logdock/agent/internal/tail"
)

// env는 실제 임시 파일과 디스크 대기로 읽기 흐름 하나를 돌린다.
type env struct {
	t    *testing.T
	log  string
	qdir string
	w    *os.File
	q    *queue.Queue
	r    *Reader
	opt  Options
	qopt queue.Options
	seen uint64 // 지금까지 확인한 마지막 순번
}

func newEnv(t *testing.T, initial string, opt Options, qopt queue.Options) *env {
	t.Helper()
	dir := t.TempDir()
	e := &env{t: t, log: filepath.Join(dir, "app.log"), qdir: filepath.Join(dir, "queue"), qopt: qopt}
	if initial != "" {
		e.w = e.openLog(initial)
	}
	opt.Path = e.log
	opt.ConfigVersion = 1
	if opt.Assemble.Format == "" {
		opt.Assemble.Format = assemble.Text
	}
	e.opt = opt
	e.open()
	t.Cleanup(e.close)
	return e
}

func (e *env) openLog(s string) *os.File {
	e.t.Helper()
	w, err := os.OpenFile(e.log, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { w.Close() })
	if _, err := w.WriteString(s); err != nil {
		e.t.Fatal(err)
	}
	return w
}

func (e *env) write(s string) {
	e.t.Helper()
	if e.w == nil {
		e.w = e.openLog(s)
		return
	}
	if _, err := e.w.WriteString(s); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) open() {
	e.t.Helper()
	q, err := queue.Open(e.qdir, e.qopt)
	if err != nil {
		e.t.Fatalf("queue.Open: %v", err)
	}
	r, err := NewReader(q, e.opt)
	if err != nil {
		e.t.Fatalf("NewReader: %v", err)
	}
	e.q, e.r = q, r
}

func (e *env) close() {
	if e.r != nil {
		e.r.Close()
		e.r = nil
	}
	if e.q != nil {
		e.q.Close()
		e.q = nil
	}
}

// restart는 에이전트를 껐다 켠다. 대기와 원본은 그대로 남는다.
func (e *env) restart() {
	e.t.Helper()
	e.close()
	e.open()
}

// fresh는 지난번 뒤로 새로 확정된 기록을 "순번 종류 내용" 꼴로 돌려준다.
func (e *env) fresh() []string {
	e.t.Helper()
	es, err := e.q.Read(e.seen+1, 1<<20, 10000)
	if err != nil {
		e.t.Fatalf("Read: %v", err)
	}
	var out []string
	for _, en := range es {
		s, err := record.Decode(en.Payload)
		if err != nil {
			e.t.Fatal(err)
		}
		switch {
		case s.Boundary != nil:
			out = append(out, fmt.Sprintf("%d boundary %s", en.Seq, s.Boundary.Kind))
		case s.Body != nil:
			out = append(out, fmt.Sprintf("%d event %s", en.Seq, *s.Body))
		default:
			out = append(out, fmt.Sprintf("%d %s", en.Seq, s.Kind))
		}
		e.seen = en.Seq
	}
	return out
}

func expect(t *testing.T, got []string, want ...string) {
	t.Helper()
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got %q\nwant %q", got, want)
	}
}

func TestLinesBecomeQueuedRecordsWithSequence(t *testing.T) {
	e := newEnv(t, "old\n", Options{}, queue.Options{})
	e.r.Step()
	expect(t, e.fresh(), "1 boundary initial_tail")
	e.write("a\nb\n")
	if st := e.r.Step(); st.State != Running {
		t.Fatalf("status %+v", st)
	}
	expect(t, e.fresh(), "2 event a", "3 event b")
}

func TestRestartContinuesWithoutDuplicates(t *testing.T) {
	e := newEnv(t, "old\n", Options{}, queue.Options{})
	e.r.Step()
	e.write("a\n")
	e.r.Step()
	e.fresh()
	e.restart()
	e.write("b\n") // 꺼져 있던 사이에 쓰였다고 봐도 같다
	e.r.Step()
	expect(t, e.fresh(), "3 event b")
}

func TestTornWriteIsReadAgainFromSource(t *testing.T) {
	e := newEnv(t, "old\n", Options{}, queue.Options{})
	e.r.Step()
	e.write("a\nbbbb\n")
	e.r.Step()
	expect(t, e.fresh(), "1 boundary initial_tail", "2 event a", "3 event bbbb")
	e.close()

	// "bbbb" 기록을 쓰다 멈춘 상황: 마지막 기록의 끝이 잘렸다
	segs, _ := filepath.Glob(filepath.Join(e.qdir, "seg-*.dat"))
	sort.Strings(segs)
	last := segs[len(segs)-1]
	fi, _ := os.Stat(last)
	if err := os.Truncate(last, fi.Size()-3); err != nil {
		t.Fatal(err)
	}
	e.open()
	e.seen = 2
	e.r.Step()
	// "a"는 다시 만들지 않고, 확정되지 않았던 "bbbb"만 원본에서 다시 읽는다
	expect(t, e.fresh(), "3 event bbbb")
}

func TestFullQueuePausesReadingUntilAcked(t *testing.T) {
	opt := Options{Tail: tail.Options{MaxReadBytes: 8}} // 한 번에 한 줄씩 읽는다
	e := newEnv(t, "", Options{}, queue.Options{})
	e.close()
	e.opt.Tail = opt.Tail
	e.qopt = queue.Options{SegmentBytes: 1, LimitBytes: 1500} // 기록마다 새 세그먼트
	e.open()
	// 먼저 연결한다. 연결 전에 있던 줄은 D02에 따라 읽지 않으므로 줄은 연결 뒤에 쓴다.
	e.r.Step()

	var lines []string
	for i := range 12 {
		line := fmt.Sprintf("line-%02d", i)
		lines = append(lines, line)
		e.write(line + "\n")
	}
	var bodies []string
	collect := func() {
		for _, s := range e.fresh() {
			var seq int
			var body string
			if n, _ := fmt.Sscanf(s, "%d event %s", &seq, &body); n == 2 {
				bodies = append(bodies, body)
			}
		}
	}

	paused := false
	for range 20 {
		if st := e.r.Step(); st.State == Paused {
			if st.Reason != ReasonQueueFull {
				t.Fatalf("paused for %q", st.Reason)
			}
			paused = true
			break
		}
	}
	if !paused {
		t.Fatal("reading never paused although the queue is over its limit")
	}
	collect()
	readBefore := len(bodies)
	e.r.Step()
	collect()
	if len(bodies) != readBefore {
		t.Fatal("kept reading while the queue was full (D01)")
	}

	if err := e.q.Ack(e.q.NextSeq() - 1); err != nil { // 수신 서버가 모두 받았다
		t.Fatal(err)
	}
	for range 30 {
		e.r.Step()
		collect()
		if len(bodies) == len(lines) {
			break
		}
		if err := e.q.Ack(e.q.NextSeq() - 1); err != nil {
			t.Fatal(err)
		}
	}
	expect(t, bodies, lines...)
}

// flaky는 정해진 횟수만큼 대기 쓰기에 실패한다.
type flaky struct {
	*queue.Queue
	fail int
}

func (f *flaky) Append(p [][]byte) (uint64, error) {
	if f.fail > 0 {
		f.fail--
		return 0, errors.New("no space left on device")
	}
	return f.Queue.Append(p)
}

func TestWriteFailureKeepsRecordsAndStopsReading(t *testing.T) {
	e := newEnv(t, "old\n", Options{}, queue.Options{})
	e.r.Close()
	store := &flaky{Queue: e.q}
	r, err := NewReader(store, e.opt)
	if err != nil {
		t.Fatal(err)
	}
	e.r = r
	e.r.Step()
	e.fresh()

	store.fail = 2
	e.write("a\n")
	if st := e.r.Step(); st.State != Failed || st.Reason != ReasonDiskUnavailable {
		t.Fatalf("status %+v, want failed/disk_unavailable", st)
	}
	e.write("b\n")
	e.r.Step() // 아직 실패. 들고 있는 "a"를 쓰기 전에는 더 읽지 않는다
	if got := e.fresh(); len(got) != 0 {
		t.Fatalf("records %v written while the disk was failing", got)
	}
	if st := e.r.Step(); st.State != Running {
		t.Fatalf("status %+v after the disk recovered", st)
	}
	expect(t, e.fresh(), "2 event a", "3 event b")
}

func TestMissingPathIsHeldUntilTheFileAppears(t *testing.T) {
	e := newEnv(t, "", Options{}, queue.Options{})
	if st := e.r.Step(); st.State != Held || st.Reason != ReasonPathMissing {
		t.Fatalf("status %+v, want held/path_missing", st)
	}
	e.write("a\n")
	if st := e.r.Step(); st.State != Running {
		t.Fatalf("status %+v", st)
	}
	expect(t, e.fresh(), "1 boundary new_file_head", "2 event a")
}

func TestUnreadableFileIsHeld(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can read files without permission")
	}
	e := newEnv(t, "", Options{}, queue.Options{})
	e.write("a\n")
	if err := os.Chmod(e.log, 0); err != nil {
		t.Fatal(err)
	}
	if st := e.r.Step(); st.State != Held || st.Reason != ReasonPermissionDenied {
		t.Fatalf("status %+v, want held/permission_denied", st)
	}
}

func TestLostRestartPositionHoldsInsteadOfStartingOver(t *testing.T) {
	e := newEnv(t, "old\n", Options{}, queue.Options{})
	e.r.Step()
	e.write("a\n")
	e.r.Step()
	if err := e.q.Ack(e.q.NextSeq() - 1); err != nil {
		t.Fatal(err)
	}
	e.close()
	segs, _ := filepath.Glob(filepath.Join(e.qdir, "seg-*.dat"))
	for _, s := range segs {
		os.Remove(s) // 재시작 위치가 든 기록이 사라졌다
	}
	e.open()
	e.write("b\n")
	if st := e.r.Step(); st.State != Held || st.Reason != ReasonRecoveryHold {
		t.Fatalf("status %+v, want held/recovery_hold (D02: no silent restart from the end)", st)
	}
	if got := e.fresh(); len(got) != 0 {
		t.Fatalf("records %v written during a recovery hold", got)
	}
}
