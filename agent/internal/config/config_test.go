package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseTOMLSubset(t *testing.T) {
	doc, err := parseTOML([]byte(`
# 설명
connection_id = "c_8f3k2"   # 끝 주석
config_version = 1_000
enabled = true

[format]
type = "multiline"
event_start = '^\d{4}-\d{2}-\d{2} '
escaped = "tab\there \"quoted\" é \\"
`))
	if err != nil {
		t.Fatal(err)
	}
	if doc[""]["connection_id"] != "c_8f3k2" || doc[""]["config_version"] != int64(1000) || doc[""]["enabled"] != true {
		t.Fatalf("top %v", doc[""])
	}
	if doc["format"]["event_start"] != `^\d{4}-\d{2}-\d{2} ` {
		t.Fatalf("literal string %q, want backslashes kept as is", doc["format"]["event_start"])
	}
	if doc["format"]["escaped"] != "tab\there \"quoted\" é \\" {
		t.Fatalf("basic string %q", doc["format"]["escaped"])
	}
}

func TestParseTOMLRejectsWhatItDoesNotSupport(t *testing.T) {
	for _, src := range []string{
		"paths = [\"/a\", \"/b\"]",    // 배열
		"limits = { a = 1 }",          // 인라인 표
		"a.b = 1",                     // 점 키
		"ratio = 0.5",                 // 실수
		"[[targets]]",                 // 표 배열
		"[a.b]",                       // 점 표
		"a = 1\na = 2",                // 같은 키 두 번
		"[t]\n[t]",                    // 같은 표 두 번
		"a = \"unterminated",          // 닫히지 않은 문자열
		"a = \"x\" trailing",          // 값 뒤 쓰레기
		"a = 01",                      // 앞자리 0
		"a = \"\"\"multi\nline\"\"\"", // 여러 줄 문자열
	} {
		if _, err := parseTOML([]byte(src)); err == nil {
			t.Errorf("parseTOML(%q) succeeded, want an error", src)
		}
	}
}

func write(t *testing.T, path, s string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(s), mode); err != nil {
		t.Fatal(err)
	}
}

const goodConn = `connection_id = "c_test1"
config_version = 3
ingest_url = "https://logdock.example.com:8443/ingest/v1"

[target]
type = "file"
path = "/var/app/order/app.log"

[format]
type = "multiline"
event_start = '^\d{4}-\d{2}-\d{2} '
log_timezone = "Asia/Seoul"
max_event_bytes = 65536
`

func TestLoadConnection(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "c_test1.toml"), goodConn, 0o644)
	c, err := LoadConnection(filepath.Join(dir, "c_test1.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if c.ID != "c_test1" || c.ConfigVersion != 3 || c.Target.Path != "/var/app/order/app.log" ||
		c.Format.EventStart == nil || !c.Format.EventStart.MatchString("2026-11-05 x") ||
		c.KeyPath != filepath.Join(dir, "c_test1.key") {
		t.Fatalf("got %+v", c)
	}
}

func TestLoadConnectionReportsEveryProblem(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "c_test1.toml")
	write(t, path, `connection_id = "c_test1"
config_version = 3
ingest_url = "http://logdock.example.com/ingest/v1"
typo_key = 1

[target]
type = "file"
path = "relative/app.log"

[format]
type = "multiline"
event_start = '(unclosed'
max_event_bytes = 65536
`, 0o644)
	_, err := LoadConnection(path)
	if err == nil {
		t.Fatal("want errors")
	}
	for _, want := range []string{"https", "typo_key", "absolute path", "event_start"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
}

func TestUnsupportedTargetsAreRejectedClearly(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "c_test1.toml")
	write(t, path, strings.Replace(goodConn, `type = "file"`, `type = "journald"`, 1), 0o644)
	if _, err := LoadConnection(path); err == nil || !strings.Contains(err.Error(), "not supported") {
		t.Fatalf("got %v", err)
	}
}

func TestOneBadConnectionDoesNotStopTheOthers(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "c_test1.toml"), goodConn, 0o644)
	write(t, filepath.Join(dir, "c_test2.toml"), "connection_id = ", 0o644)
	conns, errs := LoadConnections(dir)
	if len(conns) != 1 || len(errs) != 1 {
		t.Fatalf("conns %d errs %v", len(conns), errs)
	}
}

func TestKeyFileMustBePrivate(t *testing.T) {
	dir := t.TempDir()
	key := filepath.Join(dir, "c_test1.key")
	write(t, key, "ldk_k1_secret\n", 0o644)
	if err := CheckKeyFile(key); err == nil || !strings.Contains(err.Error(), "0600") {
		t.Fatalf("got %v, want a permission error", err)
	}
	if err := os.Chmod(key, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := CheckKeyFile(key); err != nil {
		t.Fatal(err)
	}
	if err := CheckKeyFile(key); err != nil && strings.Contains(err.Error(), "secret") {
		t.Fatal("key text leaked into an error")
	}
}

func TestExamplesStayValid(t *testing.T) {
	if _, err := LoadAgent("../../examples/agent.toml"); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConnection("../../examples/connections/c_example1.toml"); err != nil {
		t.Fatal(err)
	}
}

func TestLoadAgentDefaultsAndLimits(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.toml")
	write(t, path, "connections_dir = \"/etc/logdock-agent/connections\"\nstate_dir = \"/var/lib/logdock-agent\"\n", 0o644)
	a, err := LoadAgent(path)
	if err != nil {
		t.Fatal(err)
	}
	if a.PollInterval != 250*time.Millisecond || a.StatusInterval != 30*time.Second || a.QueueLimitBytes != 256<<20 {
		t.Fatalf("defaults %+v", a)
	}
	write(t, path, "connections_dir = \"/x\"\nstate_dir = \"/x\"\npoll_interval_ms = 1\n", 0o644)
	if _, err := LoadAgent(path); err == nil {
		t.Fatal("want errors for a too short poll interval")
	}
}
