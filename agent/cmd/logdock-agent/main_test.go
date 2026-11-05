package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// setup은 연결 하나짜리 설정을 만든다. 수신 서버에 연결하지 않으므로 주소는 합성 값이다.
func setup(t *testing.T, keyMode os.FileMode, createLog bool) string {
	t.Helper()
	dir := t.TempDir()
	conns := filepath.Join(dir, "connections")
	if err := os.MkdirAll(conns, 0o755); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(dir, "app.log")
	if createLog {
		if err := os.WriteFile(logPath, nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		filepath.Join(conns, "c_test1.toml"): fmt.Sprintf(`connection_id = "c_test1"
config_version = 2
ingest_url = "https://logdock.example.com:8443/ingest/v1"

[target]
type = "file"
path = %q

[format]
type = "text"
max_event_bytes = 65536
`, logPath),
		filepath.Join(dir, "agent.toml"): fmt.Sprintf("connections_dir = %q\nstate_dir = %q\n", conns, filepath.Join(dir, "state")),
	}
	for p, s := range files {
		if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(conns, "c_test1.key"), []byte("ldk_k1_supersecret\n"), keyMode); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, "agent.toml")
}

func runCmd(args ...string) (int, string) {
	var out, errOut bytes.Buffer
	code := run(args, &out, &errOut)
	return code, out.String() + errOut.String()
}

func TestCheckPassesAGoodConfig(t *testing.T) {
	code, out := runCmd("check", "-config", setup(t, 0o600, true))
	if code != 0 || !strings.Contains(out, "OK   c_test1") {
		t.Fatalf("exit %d output %q", code, out)
	}
}

func TestCheckWarnsWhenTargetDoesNotExistYet(t *testing.T) {
	code, out := runCmd("check", "-config", setup(t, 0o600, false))
	if code != 0 || !strings.Contains(out, "WARN c_test1") {
		t.Fatalf("exit %d output %q", code, out)
	}
}

func TestCheckFailsOnAnOpenKeyFileWithoutPrintingIt(t *testing.T) {
	code, out := runCmd("check", "-config", setup(t, 0o644, true))
	if code != 1 || !strings.Contains(out, "0600") {
		t.Fatalf("exit %d output %q", code, out)
	}
	if strings.Contains(out, "supersecret") {
		t.Fatal("check printed the key")
	}
}

func TestStatusBeforeAnyRun(t *testing.T) {
	code, out := runCmd("status", "-config", setup(t, 0o600, true))
	if code != 0 || !strings.Contains(out, "no status yet") {
		t.Fatalf("exit %d output %q", code, out)
	}
}

func TestUnknownCommand(t *testing.T) {
	if code, _ := runCmd("frobnicate"); code != 2 {
		t.Fatalf("exit %d", code)
	}
}
