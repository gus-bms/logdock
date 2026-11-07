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

// patternSetup은 setup의 연결을 dir/logs/app-*.log 파일명 규칙으로 바꾸고 logs 폴더를 돌려준다.
func patternSetup(t *testing.T) (cfgPath, logs string) {
	t.Helper()
	cfgPath = setup(t, 0o600, false)
	dir := filepath.Dir(cfgPath)
	logs = filepath.Join(dir, "logs")
	if err := os.Mkdir(logs, 0o755); err != nil {
		t.Fatal(err)
	}
	conn := filepath.Join(dir, "connections", "c_test1.toml")
	b, err := os.ReadFile(conn)
	if err != nil {
		t.Fatal(err)
	}
	s := strings.Replace(string(b), `type = "file"`, `type = "file_pattern"`, 1)
	s = strings.Replace(s, filepath.Join(dir, "app.log"), filepath.Join(logs, "app-*.log"), 1)
	if err := os.WriteFile(conn, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
	return cfgPath, logs
}

func TestCheckCountsPatternMatchesAndWarnsAboutCompressedFiles(t *testing.T) {
	cfgPath, logs := patternSetup(t)
	code, out := runCmd("check", "-config", cfgPath)
	if code != 0 || !strings.Contains(out, "WARN c_test1") || !strings.Contains(out, "no file matches yet") {
		t.Fatalf("exit %d output %q", code, out)
	}
	for _, name := range []string{"app-1.log", "app-2.log", "other.txt"} {
		if err := os.WriteFile(filepath.Join(logs, name), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	code, out = runCmd("check", "-config", cfgPath)
	if code != 0 || !strings.Contains(out, "OK   c_test1") || !strings.Contains(out, "2 files match") {
		t.Fatalf("exit %d output %q", code, out)
	}
	if err := os.WriteFile(filepath.Join(logs, "app-0.log.gz"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	// app-*.log에는 .gz가 맞지 않는다. 규칙을 넓혀야 압축 파일이 섞인다.
	conn := filepath.Join(filepath.Dir(cfgPath), "connections", "c_test1.toml")
	b, _ := os.ReadFile(conn)
	if err := os.WriteFile(conn, []byte(strings.Replace(string(b), "app-*.log", "app-*", 1)), 0o644); err != nil {
		t.Fatal(err)
	}
	code, out = runCmd("check", "-config", cfgPath)
	if code != 0 || !strings.Contains(out, "1 matching files look compressed") {
		t.Fatalf("exit %d output %q", code, out)
	}
}

// journald 연결은 journalctl과 읽을 수 있는 system journal 파일을 확인한다. 메모리에만 보관하면 알린다.
func TestCheckJournaldConnection(t *testing.T) {
	cfg := setup(t, 0o600, true)
	conn := filepath.Join(filepath.Dir(cfg), "connections", "c_test1.toml")
	if err := os.WriteFile(conn, []byte(`connection_id = "c_test1"
config_version = 1
ingest_url = "https://logdock.example.com:8443/ingest/v1"

[target]
type = "journald"
kind = "unit"
name = "order-worker"

[format]
type = "text"
max_event_bytes = 65536
`), 0o644); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	disk, mem := filepath.Join(root, "var"), filepath.Join(root, "run")
	oldDirs, oldPath := journalDirs, journalctlPath
	t.Cleanup(func() { journalDirs, journalctlPath = oldDirs, oldPath })
	journalDirs, journalctlPath = []string{disk, mem}, os.Args[0] // 있는 실행 파일이면 된다

	if code, out := runCmd("check", "-config", cfg); code != 1 || !strings.Contains(out, "no system journal file") {
		t.Fatalf("no journal: exit %d output %q", code, out)
	}
	if err := os.MkdirAll(filepath.Join(mem, "m1"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mem, "m1", "system.journal"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, out := runCmd("check", "-config", cfg); code != 0 || !strings.Contains(out, "Storage=volatile") {
		t.Fatalf("memory journal: exit %d output %q", code, out)
	}
	if err := os.MkdirAll(filepath.Join(disk, "m1"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(disk, "m1", "system.journal"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, out := runCmd("check", "-config", cfg); code != 0 || !strings.Contains(out, "OK   c_test1: unit order-worker.service") {
		t.Fatalf("disk journal: exit %d output %q", code, out)
	}
}
