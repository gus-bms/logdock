package ship

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gus-bms/logdock/agent/internal/assemble"
	"github.com/gus-bms/logdock/agent/internal/collect"
	"github.com/gus-bms/logdock/agent/internal/ingesttest"
	"github.com/gus-bms/logdock/agent/internal/queue"
)

const connID = "c_test1"

type clock struct{ now time.Time }

func (c *clock) Now() time.Time      { return c.now }
func (c *clock) add(d time.Duration) { c.now = c.now.Add(d) }

// rig는 원본 파일 → 읽기 흐름 → 디스크 대기 → 보내기 → 가짜 수신 서버를 한 줄로 잇는다.
type rig struct {
	t      *testing.T
	srv    *ingesttest.Server
	clk    *clock
	dir    string
	log    *os.File
	key    string
	q      *queue.Queue
	reader *collect.Reader
	sender *Sender
}

func newRig(t *testing.T) *rig {
	t.Helper()
	srv := ingesttest.New()
	t.Cleanup(srv.Close)
	r := &rig{t: t, srv: srv, clk: &clock{now: time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)}, dir: t.TempDir(), key: "ldk_k1_secret1"}
	srv.AddConnection(connID, r.key)
	r.writeKey(r.key)
	w, err := os.OpenFile(filepath.Join(r.dir, "app.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { w.Close() })
	r.log = w
	r.start("queue-a", 1)
	return r
}

func (r *rig) writeKey(k string) {
	r.t.Helper()
	if err := os.WriteFile(filepath.Join(r.dir, connID+".key"), []byte(k+"\n"), 0o600); err != nil {
		r.t.Fatal(err)
	}
}

// start는 에이전트를 켠다. 대기 폴더와 설정 버전을 고를 수 있다.
func (r *rig) start(queueDir string, configVersion int) {
	r.t.Helper()
	q, err := queue.Open(filepath.Join(r.dir, queueDir), queue.Options{})
	if err != nil {
		r.t.Fatal(err)
	}
	reader, err := collect.NewReader(q, collect.Options{
		Path: filepath.Join(r.dir, "app.log"), ConfigVersion: configVersion,
		Assemble: assemble.Options{Format: assemble.Text},
	})
	if err != nil {
		r.t.Fatal(err)
	}
	r.q, r.reader = q, reader
	r.sender = New(q, Options{
		URL: r.srv.IngestURL(), ConnectionID: connID, KeyPath: filepath.Join(r.dir, connID+".key"),
		InstanceID: "a_test", AgentVersion: "0.1.0-test", Timezone: "Asia/Seoul",
		Client: r.srv.Client(), BackoffMin: time.Second, BackoffMax: time.Minute, HoldRetry: time.Minute,
		Now: r.clk.Now, Jitter: func() float64 { return 0.5 },
	})
	r.t.Cleanup(func() { reader.Close(); q.Close() })
}

func (r *rig) stop() {
	r.reader.Close()
	r.q.Close()
}

func (r *rig) write(lines ...string) {
	r.t.Helper()
	for _, l := range lines {
		if _, err := r.log.WriteString(l + "\n"); err != nil {
			r.t.Fatal(err)
		}
	}
}

// pump는 읽기와 보내기를 번갈아 n번 돌린다.
func (r *rig) pump(n int) Status {
	var st Status
	for range n {
		r.reader.Step()
		st = r.sender.Step(context.Background())
	}
	return st
}

// stored는 서버에 저장된 이벤트 본문이다. 세대마다 순번이 빈틈없이 1씩 느는지도 본다.
func (r *rig) stored() []string {
	r.t.Helper()
	var bodies []string
	next := map[uint16]uint64{}
	for _, s := range r.srv.Records(connID) {
		want := next[s.Generation] + 1
		if s.Record.Seq != want {
			r.t.Fatalf("generation %d: stored seq %d, want %d", s.Generation, s.Record.Seq, want)
		}
		next[s.Generation] = s.Record.Seq
		if s.Record.Body != nil {
			bodies = append(bodies, *s.Record.Body)
		}
	}
	return bodies
}

func lines(prefix string, n int) []string {
	var out []string
	for i := range n {
		out = append(out, fmt.Sprintf("%s-%02d", prefix, i))
	}
	return out
}

func expect(t *testing.T, got, want []string) {
	t.Helper()
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got  %q\nwant %q", got, want)
	}
}

func TestEveryLineIsStoredOnceInOrder(t *testing.T) {
	r := newRig(t)
	r.pump(1) // 연결: 지금 파일 끝에서 시작한다
	want := lines("a", 50)
	r.write(want...)
	if st := r.pump(3); st.State != OK {
		t.Fatalf("status %v", st)
	}
	expect(t, r.stored(), want)
	if r.q.Generation() != 1 || r.q.AckedThrough() != r.q.NextSeq()-1 {
		t.Fatalf("generation %d acked %d next %d", r.q.Generation(), r.q.AckedThrough(), r.q.NextSeq())
	}
}

func TestLostResponseIsResentAndStoredOnce(t *testing.T) {
	r := newRig(t)
	r.pump(1)
	// 서버는 저장했지만 응답이 오지 않은 상황
	r.srv.InjectFault(ingesttest.Fault{Status: 503, Code: "storage_unavailable", StoreFirst: true})
	want := lines("a", 5)
	r.write(want...)
	if st := r.pump(1); st.State != Retrying || st.Reason != "storage_unavailable" {
		t.Fatalf("status %v", st)
	}
	r.clk.add(2 * time.Second) // 백오프가 지났다
	if st := r.pump(1); st.State != OK {
		t.Fatalf("status %v", st)
	}
	expect(t, r.stored(), want)
	if r.srv.Duplicates() == 0 {
		t.Fatal("the resent batch should have been counted as duplicates by the server")
	}
}

func TestRevokedKeyHoldsUntilANewKeyArrives(t *testing.T) {
	r := newRig(t)
	r.pump(1)
	r.write(lines("a", 3)...)
	r.pump(1)

	r.srv.RevokeKey(r.key)
	r.write(lines("b", 3)...)
	if st := r.pump(3); st.State != Held || st.Reason != "key_revoked" {
		t.Fatalf("status %v", st)
	}
	if got := len(r.stored()); got != 3 {
		t.Fatalf("%d stored while the key was revoked", got)
	}
	// 읽기는 계속돼 대기에 쌓인다(Q05-01)
	if r.q.NextSeq()-1 <= r.q.AckedThrough() {
		t.Fatal("reading stopped while sending was held")
	}

	r.srv.IssueKey(connID, "ldk_k2_secret2")
	r.writeKey("ldk_k2_secret2") // 서버 운영자가 새 키를 적용했다
	if st := r.pump(1); st.State != OK {
		t.Fatalf("status %v after the new key", st)
	}
	expect(t, r.stored(), append(lines("a", 3), lines("b", 3)...))
}

func TestTooLargeBatchIsSplit(t *testing.T) {
	r := newRig(t)
	r.pump(1)
	r.srv.SetLimit(4000) // 기록 몇 개만 들어가는 크기
	want := lines("a", 40)
	r.write(want...)
	r.pump(40)
	expect(t, r.stored(), want)
}

func TestBusyServerIsRetriedAfterItsDelay(t *testing.T) {
	r := newRig(t)
	r.pump(1)
	r.srv.InjectFault(ingesttest.Fault{Status: 429, Code: "busy", RetryAfter: "5"})
	r.write("a")
	if st := r.pump(1); st.State != Retrying || st.Reason != "server_busy" {
		t.Fatalf("status %v", st)
	}
	r.clk.add(4 * time.Second)
	r.pump(1)
	if len(r.stored()) != 0 {
		t.Fatal("retried before Retry-After")
	}
	r.clk.add(time.Second)
	r.pump(1)
	expect(t, r.stored(), []string{"a"})
}

func TestReinstallGetsANewGenerationSoLogsAreNotDropped(t *testing.T) {
	r := newRig(t)
	r.pump(1)
	r.write(lines("a", 3)...)
	r.pump(1)

	// 재설치: 대기와 상태가 모두 사라진 에이전트가 다시 시작한다
	r.stop()
	r.start("queue-b", 1)
	r.pump(1)
	r.write(lines("b", 3)...)
	if st := r.pump(2); st.State != OK {
		t.Fatalf("status %v", st)
	}
	if r.q.Generation() != 2 {
		t.Fatalf("generation %d, want a new one from the server", r.q.Generation())
	}
	// 순번이 다시 1부터지만 세대가 달라 중복으로 버려지지 않는다
	expect(t, r.stored(), append(lines("a", 3), lines("b", 3)...))
}

func TestConfigVersionChangeSplitsBatches(t *testing.T) {
	r := newRig(t)
	r.pump(1)
	r.write("v1-a")
	r.reader.Step()

	// 새 설정을 적용하고 에이전트를 다시 켰다. 보내기 전에 두 버전의 기록이 대기에 함께 있다
	r.stop()
	r.start("queue-a", 2)
	r.write("v2-a")
	r.reader.Step()
	r.pump(3)
	for _, s := range r.srv.Records(connID) {
		if s.Record.Body == nil {
			continue
		}
		want := map[string]int{"v1-a": 1, "v2-a": 2}[*s.Record.Body]
		if s.ConfigVersion != want {
			t.Fatalf("%q stored with config version %d, want %d", *s.Record.Body, s.ConfigVersion, want)
		}
	}
	expect(t, r.stored(), []string{"v1-a", "v2-a"})
}

func TestArchivedConnectionHoldsAndKeepsTheQueue(t *testing.T) {
	r := newRig(t)
	r.pump(1)
	r.srv.Archive(connID)
	r.write("a")
	if st := r.pump(2); st.State != Held || st.Reason != "connection_archived" {
		t.Fatalf("status %v", st)
	}
	if r.q.AckedThrough() >= r.q.NextSeq()-1 {
		t.Fatal("queued records were dropped although nothing was stored")
	}
}

func TestServerAskingForDeletedRecordsHolds(t *testing.T) {
	r := newRig(t)
	r.pump(1)
	r.write(lines("a", 3)...)
	r.pump(1)
	r.srv.Forget(connID) // 수신 서버가 순번 기록을 잃었다
	r.write("b")
	if st := r.pump(1); st.State != Held || st.Reason != "bad_batch" {
		t.Fatalf("status %v, want held: the server asks for records already acked and deleted", st)
	}
}
