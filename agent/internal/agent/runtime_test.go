package agent

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gus-bms/logdock/agent/internal/config"
	"github.com/gus-bms/logdock/agent/internal/ingesttest"
)

const (
	connID = "c_test1"
	key    = "ldk_k1_secret1"
)

// setup은 실제 설정 파일·키 파일·CA 파일로 에이전트 한 대를 준비한다.
func setup(t *testing.T) (config.Agent, *ingesttest.Server, *os.File) {
	t.Helper()
	srv := ingesttest.New()
	t.Cleanup(srv.Close)
	srv.AddConnection(connID, key)
	dir := t.TempDir()
	conns := filepath.Join(dir, "connections")
	if err := os.MkdirAll(conns, 0o755); err != nil {
		t.Fatal(err)
	}
	ca := filepath.Join(dir, "ca.pem")
	if err := srv.WriteCA(ca); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(dir, "app.log")
	w, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { w.Close() })
	if _, err := w.WriteString("old line written before connecting\n"); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(conns, connID+".toml"), fmt.Sprintf(`connection_id = %q
config_version = 1
ingest_url = %q
ca_file = %q

[target]
type = "file"
path = %q

[format]
type = "text"
max_event_bytes = 65536
`, connID, srv.IngestURL(), ca, logPath), 0o644)
	mustWrite(t, filepath.Join(conns, connID+".key"), key+"\n", 0o600)
	agentPath := filepath.Join(dir, "agent.toml")
	mustWrite(t, agentPath, fmt.Sprintf("connections_dir = %q\nstate_dir = %q\npoll_interval_ms = 20\nstatus_interval_ms = 200\n",
		conns, filepath.Join(dir, "state")), 0o644)
	cfg, err := config.LoadAgent(agentPath)
	if err != nil {
		t.Fatal(err)
	}
	return cfg, srv, w
}

func mustWrite(t *testing.T, path, s string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(s), mode); err != nil {
		t.Fatal(err)
	}
}

// start는 에이전트를 띄우고, 멈추는 함수를 돌려준다. 멈추는 데 2초가 넘으면 실패한다.
func start(t *testing.T, cfg config.Agent) (stop func()) {
	t.Helper()
	rt, err := New(cfg, "0.1.0-test", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- rt.Run(ctx) }()
	return func() {
		t.Helper()
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("agent did not stop promptly after the stop signal (Q05-02)")
		}
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func bodies(srv *ingesttest.Server) []string {
	var out []string
	for _, s := range srv.Records(connID) {
		if s.Record.Body != nil {
			out = append(out, *s.Record.Body)
		}
	}
	return out
}

func lastReport(srv *ingesttest.Server) map[string]any {
	reps := srv.Reports(connID)
	if len(reps) == 0 {
		return nil
	}
	return reps[len(reps)-1]
}

func field(rep map[string]any, part, name string) any {
	m, _ := rep[part].(map[string]any)
	return m[name]
}

func writeLines(t *testing.T, w *os.File, prefix string, n int) []string {
	t.Helper()
	var lines []string
	for i := range n {
		l := fmt.Sprintf("%s-%02d", prefix, i)
		lines = append(lines, l)
		if _, err := w.WriteString(l + "\n"); err != nil {
			t.Fatal(err)
		}
	}
	return lines
}

func TestAgentDeliversReportsStopsAndResumes(t *testing.T) {
	cfg, srv, w := setup(t)
	stop := start(t, cfg)
	// 연결이 시작돼 시작 경계를 보낼 때까지 기다린 뒤 쓴다(그 전 줄은 D02로 읽지 않는다)
	waitFor(t, "the initial boundary", func() bool { return len(srv.Records(connID)) >= 1 })
	want := writeLines(t, w, "a", 10)
	waitFor(t, "all lines stored", func() bool { return len(bodies(srv)) == len(want) })
	waitFor(t, "a running status report", func() bool {
		rep := lastReport(srv)
		return rep != nil && field(rep, "read", "state") == "running" && field(rep, "send", "state") == "ok"
	})
	stop()
	if rep := lastReport(srv); field(rep, "read", "state") != "stopping" || field(rep, "read", "reason") != "operator_stop" {
		t.Fatalf("last report %v, want the operator stop", rep["read"])
	}

	// 다시 켜면 같은 대기와 재시작 위치에서 이어간다. 꺼져 있던 사이의 줄도 읽는다
	more := writeLines(t, w, "b", 5)
	stop = start(t, cfg)
	defer stop()
	want = append(want, more...)
	waitFor(t, "lines written while stopped", func() bool { return len(bodies(srv)) >= len(want) })
	if got := bodies(srv); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("stored %q\nwant   %q", got, want)
	}
	if n := len(srv.Records(connID)); n != len(want)+1 {
		t.Fatalf("%d records stored, want %d lines and one initial boundary", n, len(want))
	}
}

func TestLocalStatusNeverHoldsTheKey(t *testing.T) {
	cfg, srv, _ := setup(t)
	stop := start(t, cfg)
	waitFor(t, "the initial boundary", func() bool { return len(srv.Records(connID)) >= 1 })
	stop()
	b, err := os.ReadFile(filepath.Join(LocalStatusDir(cfg), connID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "secret1") || !strings.Contains(string(b), connID) {
		t.Fatalf("local status %s", b)
	}
}

func TestBadKeyPermissionStopsOnlyThatConnection(t *testing.T) {
	cfg, srv, _ := setup(t)
	if err := os.Chmod(filepath.Join(cfg.ConnectionsDir, connID+".key"), 0o644); err != nil {
		t.Fatal(err)
	}
	stop := start(t, cfg)
	path := filepath.Join(LocalStatusDir(cfg), connID+".json")
	waitFor(t, "the not-started status", func() bool {
		b, err := os.ReadFile(path)
		return err == nil && strings.Contains(string(b), "0600")
	})
	stop()
	if len(srv.Records(connID)) != 0 {
		t.Fatal("sent with a key file other accounts can read")
	}
}

func TestInstanceIDIsKeptAcrossRestarts(t *testing.T) {
	cfg, _, _ := setup(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	a, err := New(cfg, "t", log)
	if err != nil {
		t.Fatal(err)
	}
	b, err := New(cfg, "t", log)
	if err != nil {
		t.Fatal(err)
	}
	if a.InstanceID() != b.InstanceID() || !instanceIDPattern.MatchString(a.InstanceID()) {
		t.Fatalf("instance ids %q and %q", a.InstanceID(), b.InstanceID())
	}
}
