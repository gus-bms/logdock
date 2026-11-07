package collect

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/gus-bms/logdock/agent/internal/assemble"
	"github.com/gus-bms/logdock/agent/internal/journal"
	"github.com/gus-bms/logdock/agent/internal/journaltest"
	"github.com/gus-bms/logdock/agent/internal/queue"
	"github.com/gus-bms/logdock/agent/internal/record"
)

// jenv는 가짜 journal과 실제 디스크 대기로 journald 연결 하나를 돌린다.
type jenv struct {
	t     *testing.T
	j     *journaltest.Journal
	jfile string // 읽기 권한 확인에 쓰는 가짜 system journal 파일
	qdir  string
	qopt  queue.Options
	opt   Options
	q     *queue.Queue
	r     *JournalReader
	seen  uint64
}

func newJEnv(t *testing.T, mod func(*Options)) *jenv {
	t.Helper()
	dir := t.TempDir()
	jdir := filepath.Join(dir, "journal")
	e := &jenv{t: t, j: journaltest.New(), jfile: filepath.Join(jdir, "0f1e", "system.journal"), qdir: filepath.Join(dir, "queue")}
	if err := os.MkdirAll(filepath.Dir(e.jfile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(e.jfile, []byte("LPKSHHRH"), 0o644); err != nil {
		t.Fatal(err)
	}
	e.opt = Options{ConfigVersion: 1, Assemble: assemble.Options{Format: assemble.Text}, Journal: JournalOptions{
		Target: journal.Target{Kind: "container", Name: "web"}, Start: e.j.Start, Dirs: []string{jdir},
		RetryWait: 10 * time.Millisecond, MaxRetryWait: 40 * time.Millisecond,
	}}
	if mod != nil {
		mod(&e.opt)
	}
	e.open()
	t.Cleanup(e.close)
	return e
}

func (e *jenv) open() {
	e.t.Helper()
	q, err := queue.Open(e.qdir, e.qopt)
	if err != nil {
		e.t.Fatalf("queue.Open: %v", err)
	}
	r, err := NewJournalReader(q, e.opt)
	if err != nil {
		e.t.Fatalf("NewJournalReader: %v", err)
	}
	e.q, e.r = q, r
}

func (e *jenv) close() {
	if e.r != nil {
		e.r.Close()
		e.r = nil
	}
	if e.q != nil {
		e.q.Close()
		e.q = nil
	}
}

func (e *jenv) restart() {
	e.close()
	e.open()
}

func (e *jenv) web(msg string, extra ...string) string {
	return e.j.Add(append(extra, "CONTAINER_NAME=web", "CONTAINER_ID_FULL=cid1", "PRIORITY=6",
		"_SYSTEMD_UNIT=docker.service", "MESSAGE="+msg)...)
}

// fresh는 지난번 뒤로 새로 확정된 기록을 "순번 종류 내용" 꼴로 돌려준다.
func (e *jenv) fresh() []string {
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

// collect는 기록 n개가 확정될 때까지 Step을 부른다. journalctl 출력은 따로 도는 고루틴이 읽는다.
func (e *jenv) collect(n int) []string {
	e.t.Helper()
	var got []string
	for deadline := time.Now().Add(5 * time.Second); len(got) < n && time.Now().Before(deadline); {
		e.r.Step()
		got = append(got, e.fresh()...)
		if len(got) < n {
			time.Sleep(2 * time.Millisecond)
		}
	}
	return got
}

// quiet는 더 나오는 기록이 없는지 본다.
func (e *jenv) quiet() {
	e.t.Helper()
	for range 20 {
		e.r.Step()
		time.Sleep(time.Millisecond)
	}
	if extra := e.fresh(); len(extra) > 0 {
		e.t.Fatalf("unexpected records %q", extra)
	}
}

// waitState는 읽기 상태가 바뀔 때까지 Step을 부른다.
func (e *jenv) waitState(state ReadState) Status {
	e.t.Helper()
	var st Status
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		if st = e.r.Step(); st.State == state {
			return st
		}
		time.Sleep(2 * time.Millisecond)
	}
	e.t.Fatalf("state %s (%s), want %s", st.State, st.Reason, state)
	return st
}

// D02: 최초 연결은 그때 journal의 마지막 항목 뒤부터 읽고, 재시작하면 확정한 위치에서 잇는다.
func TestJournaldStartsAfterLastEntryAndResumes(t *testing.T) {
	e := newJEnv(t, nil)
	e.web("old 1")
	e.web("old 2")
	expect(t, e.collect(1), "1 boundary initial_tail")
	c := e.web("new 1")
	expect(t, e.collect(1), "2 event new 1")
	e.restart()
	e.web("new 2")
	expect(t, e.collect(1), "3 event new 2")
	e.quiet()
	calls := e.j.Calls()
	if last := calls[len(calls)-1]; !slices.Contains(last, "--cursor="+c) || !slices.Contains(last, "--follow") {
		t.Fatalf("restart must follow from the saved cursor: %q", last)
	}
}

// 나뉜 줄 사이에 다른 출력의 줄이 껴도 순서대로 묶어 내고, 재시작해도 다시 내지 않는다.
func TestJournaldJoinsSplitLinesAcrossRestart(t *testing.T) {
	e := newJEnv(t, nil)
	expect(t, e.collect(1), "1 boundary initial_tail")
	e.web("aaa", "CONTAINER_PARTIAL_ID=x", "CONTAINER_PARTIAL_ORDINAL=1", "CONTAINER_PARTIAL_LAST=false", "CONTAINER_PARTIAL_MESSAGE=true")
	e.web("err", "PRIORITY=3")
	e.web("bbb", "CONTAINER_PARTIAL_ID=x", "CONTAINER_PARTIAL_ORDINAL=2", "CONTAINER_PARTIAL_LAST=true")
	expect(t, e.collect(2), "2 event err", "3 event aaabbb")
	e.restart()
	e.web("next")
	expect(t, e.collect(1), "4 event next")
	e.quiet()
}

// 저장한 항목이 journal 보관 한도로 지워졌으면 그 사이를 건너뛰지 않고 복구 보류로 둔다(D02, Q06).
func TestJournaldHoldsWhenSavedEntryIsGone(t *testing.T) {
	e := newJEnv(t, nil)
	expect(t, e.collect(1), "1 boundary initial_tail")
	e.web("a")
	expect(t, e.collect(1), "2 event a")
	e.close()
	e.j.Vacuum(10)
	e.web("b")
	e.open()
	if st := e.waitState(Held); st.Reason != ReasonRecoveryHold {
		t.Fatalf("reason %q", st.Reason)
	}
	e.quiet()
}

// D01: 대기가 가득 차면 journalctl을 끝내고, 자리가 나면 확정한 위치에서 다시 띄워 빠짐없이 잇는다.
func TestJournaldPausesOnFullQueueAndResumes(t *testing.T) {
	e := newJEnv(t, nil)
	e.close()
	e.qopt = queue.Options{SegmentBytes: 1, LimitBytes: 3000}
	e.open()
	expect(t, e.collect(1), "1 boundary initial_tail")
	var want, got []string
	keep := func(rs []string) {
		for _, r := range rs {
			_, body, _ := strings.Cut(r, " event ")
			got = append(got, body)
		}
	}
	// 한 줄씩 써서 모두 읽기 전에 대기가 차게 한다.
	paused := false
	for i := range 30 {
		msg := fmt.Sprintf("line %02d", i)
		e.web(msg)
		want = append(want, msg)
		if !paused {
			keep(e.collect(1))
			paused = e.r.Step().State == Paused
		}
	}
	if !paused {
		t.Fatal("the queue never filled")
	}
	follows := len(e.j.Calls())
	keep(e.fresh())
	for deadline := time.Now().Add(5 * time.Second); len(got) < len(want) && time.Now().Before(deadline); {
		if err := e.q.Ack(e.q.NextSeq() - 1); err != nil { // 수신 서버가 모두 받았다
			t.Fatal(err)
		}
		e.r.Step()
		keep(e.fresh())
		time.Sleep(2 * time.Millisecond)
	}
	if !slices.Equal(got, want) {
		t.Fatalf("got %q\nwant %q", got, want)
	}
	if len(e.j.Calls()) <= follows {
		t.Fatal("journalctl must be started again after the pause")
	}
}

// 한 번에 쓴 기록이 대기 한도를 넘긴 채 한 세그먼트에 들어가도, 모두 수신 확인되면 다시 읽는다.
// 재시작 위치 때문에 남는 마지막 세그먼트를 멈춤·재개 판단에서 세면 영영 멈춰 있게 된다.
func TestJournaldResumesAfterOneBatchFilledQueue(t *testing.T) {
	e := newJEnv(t, nil)
	e.close()
	e.qopt = queue.Options{SegmentBytes: 1, LimitBytes: 3000}
	e.open()
	expect(t, e.collect(1), "1 boundary initial_tail")
	for i := range 30 {
		e.web(fmt.Sprintf("line %02d", i))
	}
	n := len(e.collect(1))
	e.waitState(Paused)
	n += len(e.fresh())
	for deadline := time.Now().Add(5 * time.Second); n < 30 && time.Now().Before(deadline); {
		if err := e.q.Ack(e.q.NextSeq() - 1); err != nil {
			t.Fatal(err)
		}
		e.r.Step()
		n += len(e.fresh())
		time.Sleep(time.Millisecond)
	}
	if n != 30 {
		t.Fatalf("got %d of 30 events", n)
	}
}

// journalctl이 끝나면 잠시 뒤 확정한 위치에서 다시 띄운다.
func TestJournaldRestartsJournalctlAfterCrash(t *testing.T) {
	e := newJEnv(t, nil)
	expect(t, e.collect(1), "1 boundary initial_tail")
	c := e.web("a")
	expect(t, e.collect(1), "2 event a")
	e.j.Crash()
	if st := e.waitState(Held); st.Reason != ReasonReadError || e.r.Err() == nil {
		t.Fatalf("after crash: %+v %v", st, e.r.Err())
	}
	e.web("b")
	expect(t, e.collect(1), "3 event b")
	calls := e.j.Calls()
	if last := calls[len(calls)-1]; !slices.Contains(last, "--cursor="+c) {
		t.Fatalf("must resume from the saved cursor: %q", last)
	}
}

// journalctl은 권한이 없어도 빈 결과만 내므로 journal 파일로 확인하고 알린다.
func TestJournaldReportsMissingPermission(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can read any file")
	}
	e := newJEnv(t, nil)
	e.close()
	if err := os.Chmod(e.jfile, 0); err != nil {
		t.Fatal(err)
	}
	e.open()
	if st := e.waitState(Held); st.Reason != ReasonPermissionDenied {
		t.Fatalf("reason %q", st.Reason)
	}
	if err := os.Chmod(e.jfile, 0o644); err != nil {
		t.Fatal(err)
	}
	expect(t, e.collect(1), "1 boundary initial_tail")
}

// journald가 속도 제한으로 버린 메시지는 원본 소실 경계로 남기고 상태 보고에도 싣는다.
func TestJournaldRecordsRateLimitDrops(t *testing.T) {
	e := newJEnv(t, func(o *Options) { o.Journal.Target = journal.Target{Kind: "unit", Name: "order.service"} })
	expect(t, e.collect(1), "1 boundary initial_tail")
	e.j.Add("_SYSTEMD_UNIT=order.service", "_STREAM_ID=s1", "MESSAGE=before")
	e.j.Add("MESSAGE_ID="+journal.MessageIDDropped, "_SYSTEMD_UNIT=systemd-journald.service",
		"OBJECT_SYSTEMD_UNIT=order.service", "N_DROPPED=4210", "MESSAGE=Suppressed 4210 messages from order.service")
	e.j.Add("_SYSTEMD_UNIT=order.service", "_STREAM_ID=s1", "MESSAGE=after")
	expect(t, e.collect(3), "2 event before", "3 boundary source_dropped", "4 event after")
	loss := e.r.Status().Loss
	if len(loss) != 1 || !loss[0].Journal || loss[0].Dropped != 4210 || loss[0].Unit != "order.service" || loss[0].ShareUnknown {
		t.Fatalf("loss %+v", loss)
	}
}
