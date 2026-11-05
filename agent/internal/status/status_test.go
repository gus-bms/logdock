package status

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/gus-bms/logdock/agent/internal/collect"
	"github.com/gus-bms/logdock/agent/internal/ship"
	"github.com/gus-bms/logdock/agent/internal/tail"
)

type clock struct{ now time.Time }

func (c *clock) Now() time.Time { return c.now }

func TestUnknownValuesAreSentAsNull(t *testing.T) {
	clk := &clock{now: time.Date(2026, 11, 5, 1, 0, 0, 0, time.UTC)}
	r := New(Options{ConnectionID: "c_test1", Now: clk.Now})
	snap := Snapshot{
		ConfigVersion: 3,
		Read: collect.Status{State: collect.Running, Loss: []collect.Loss{
			{Kind: "gone_before_read", FileID: "f_1_2", SkippedBytes: tail.Unknown},
		}},
		Send: ship.Status{State: ship.OK},
	}
	b, err := json.Marshal(r.build(snap, clk.now))
	if err != nil {
		t.Fatal(err)
	}
	js := string(b)
	for _, want := range []string{
		`"last_read_at":null`,       // 아직 읽은 적 없음
		`"last_ack_at":null`,        // 아직 응답 없음
		`"oldest_observed_at":null`, // 대기 없음
		`"cpu_ratio":null`,          // 잴 수 없었음
		`"skipped_unknown":true`,    // 잃은 크기를 모름
		`"diag_write_error":false`,
	} {
		if !strings.Contains(js, want) {
			t.Errorf("report %s does not contain %s", js, want)
		}
	}
	if strings.Contains(js, `"skipped_bytes":0`) {
		t.Error("an unknown loss was reported as 0 bytes")
	}
}

func TestStoppingIsReportedAsOperatorStop(t *testing.T) {
	r := New(Options{ConnectionID: "c_test1"})
	rep := r.build(Snapshot{Read: collect.Status{State: collect.Running}, Stopping: true}, time.Now())
	if rep.Read.State != "stopping" || rep.Read.Reason != "operator_stop" {
		t.Fatalf("read %+v", rep.Read)
	}
}

func TestReportIsDueOnIntervalOrOnChangeButNotTooOften(t *testing.T) {
	clk := &clock{now: time.Date(2026, 11, 5, 1, 0, 0, 0, time.UTC)}
	r := New(Options{Interval: 30 * time.Second, MinGap: time.Second, Now: clk.Now})
	running := Snapshot{Read: collect.Status{State: collect.Running}, Send: ship.Status{State: ship.OK}}
	if !r.Due(running) {
		t.Fatal("the first report should be due")
	}
	r.lastSent, r.lastKey = clk.now, stateKey(running)

	held := running
	held.Send = ship.Status{State: ship.Held, Reason: "key_revoked"}
	clk.now = clk.now.Add(500 * time.Millisecond)
	if r.Due(held) {
		t.Fatal("a change must still respect the minimum gap")
	}
	clk.now = clk.now.Add(time.Second)
	if !r.Due(held) {
		t.Fatal("a state change should be reported right after the minimum gap")
	}
	if r.Due(running) {
		t.Fatal("nothing changed and the interval has not passed")
	}
	clk.now = clk.now.Add(30 * time.Second)
	if !r.Due(running) {
		t.Fatal("the regular interval passed")
	}
}
