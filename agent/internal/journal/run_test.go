package journal_test

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/gus-bms/logdock/agent/internal/journal"
	"github.com/gus-bms/logdock/agent/internal/journaltest"
)

// 이 시험 실행 파일을 가짜 journalctl로도 쓴다(ExecStarter 시험).
func TestMain(m *testing.M) {
	if os.Getenv("LOGDOCK_FAKE_JOURNALCTL") == "1" {
		fakeJournalctl(os.Args[1:])
		return
	}
	os.Exit(m.Run())
}

func fakeJournalctl(args []string) {
	if slices.Contains(args, "--cursor=s=bad") {
		fmt.Fprintln(os.Stderr, "Failed to seek to cursor: Invalid argument")
		os.Exit(1)
	}
	for i := range 2 {
		journal.WriteExport(os.Stdout, journal.NewEntry(fmt.Sprintf("__CURSOR=s=x;i=%d", i+1), "MESSAGE=line "+fmt.Sprint(i+1)))
	}
	if slices.Contains(args, "--follow") {
		time.Sleep(time.Hour) // 실제 journalctl처럼 끝내기 전까지 멈춰 있다
	}
	os.Exit(0)
}

func target() journal.Target { return journal.Target{Kind: "container", Name: "web"} }

func TestArgsUseCursorWithoutAfterCursor(t *testing.T) {
	got := journal.FollowArgs(target(), "s=x;i=3")
	want := []string{"--system", "--output=export", "--follow", "--no-tail", "--no-pager", "--cursor=s=x;i=3",
		"CONTAINER_NAME=web", "+", "MESSAGE_ID=" + journal.MessageIDDropped}
	if !slices.Equal(got, want) {
		t.Fatalf("follow args %q", got)
	}
	if got := journal.ProbeArgs(journal.Target{Kind: "unit", Name: "order.service"}, ""); !slices.Contains(got, "--lines=1") ||
		!slices.Contains(got, "_SYSTEMD_UNIT=order.service") || slices.Contains(got, "--follow") {
		t.Fatalf("probe args %q", got)
	}
}

func TestProbeAndFollowWithFakeJournal(t *testing.T) {
	j := journaltest.New()
	j.Add("CONTAINER_NAME=web", "MESSAGE=one")
	j.Add("CONTAINER_NAME=other", "MESSAGE=not mine")
	c2 := j.Add("CONTAINER_NAME=web", "MESSAGE=two")
	last, ok, err := journal.Probe(j.Start, journal.ProbeArgs(target(), ""), 0)
	if err != nil || !ok || last.String(journal.FieldCursor) != c2 {
		t.Fatalf("probe: %v %v %q", err, ok, last.String(journal.FieldCursor))
	}
	run, err := journal.Follow(j.Start, journal.FollowArgs(target(), c2), 0, 4)
	if err != nil {
		t.Fatal(err)
	}
	defer run.Stop()
	if got := next(t, run).String(journal.FieldMessage); got != "two" {
		t.Fatalf("first followed entry %q", got)
	}
	j.Add("CONTAINER_NAME=web", "MESSAGE=three")
	if got := next(t, run).String(journal.FieldMessage); got != "three" {
		t.Fatalf("new entry %q", got)
	}
	run.Stop()
	if _, ok := <-run.Entries(); ok {
		t.Fatal("entries must be closed after Stop")
	}
}

func next(t *testing.T, r *journal.Run) journal.Entry {
	t.Helper()
	select {
	case e, ok := <-r.Entries():
		if !ok {
			t.Fatalf("closed: %v", r.Err())
		}
		return e
	case <-time.After(5 * time.Second):
		t.Fatal("no entry")
	}
	return journal.Entry{}
}

// journalctl이 실패로 끝나면 항목이 없다고 보지 않는다. 저장한 위치가 사라졌다고 잘못 판단해
// 복구 보류로 가지 않게 하기 위해서다.
func TestProbeReportsFailureNotAbsence(t *testing.T) {
	j := journaltest.New()
	j.ExitErr = errors.New("exit status 1")
	if _, ok, err := journal.Probe(j.Start, journal.ProbeArgs(target(), "s=fake;i=1"), 0); err == nil || ok {
		t.Fatalf("got ok=%v err=%v", ok, err)
	}
}

// 실제 프로세스로 띄우고 끝내는 경로를 확인한다. 가짜 journalctl은 이 시험 실행 파일이다.
func TestExecStarterRunsAndStopsProcess(t *testing.T) {
	start := journal.ExecStarter(os.Args[0], append(os.Environ(), "LOGDOCK_FAKE_JOURNALCTL=1"))
	run, err := journal.Follow(start, journal.FollowArgs(target(), ""), 0, 4)
	if err != nil {
		t.Fatal(err)
	}
	for i := range 2 {
		if got := next(t, run).String(journal.FieldMessage); got != fmt.Sprintf("line %d", i+1) {
			t.Fatalf("entry %d: %q", i, got)
		}
	}
	done := make(chan struct{})
	go func() { run.Stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Stop did not end the process")
	}
	_, ok, err := journal.Probe(start, journal.ProbeArgs(target(), "s=bad"), 0)
	if ok || err == nil || !strings.Contains(err.Error(), "Invalid argument") {
		t.Fatalf("failed probe: ok=%v err=%v", ok, err)
	}
	if _, ok, err := journal.Probe(start, journal.ProbeArgs(target(), ""), 0); !ok || err != nil {
		t.Fatalf("probe: ok=%v err=%v", ok, err)
	}
}

func TestCheckAccess(t *testing.T) {
	root := t.TempDir()
	disk, mem := filepath.Join(root, "var"), filepath.Join(root, "run")
	put := func(dir, name string, mode os.FileMode) string {
		t.Helper()
		p := filepath.Join(dir, "0f1e2d3c", name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("LPKSHHRH"), mode); err != nil {
			t.Fatal(err)
		}
		return p
	}
	if _, err := journal.CheckAccess([]string{disk, mem}); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("no journal: %v", err)
	}
	put(mem, "system.journal", 0o644)
	if persistent, err := journal.CheckAccess([]string{disk, mem}); err != nil || persistent {
		t.Fatalf("memory journal: %v %v", persistent, err)
	}
	put(disk, "user-1000.journal", 0o644) // 사용자 journal만으로는 시스템 로그를 읽을 수 없다
	locked := put(disk, "system@0001.journal", 0o000)
	if os.Geteuid() != 0 {
		if _, err := journal.CheckAccess([]string{disk}); !errors.Is(err, fs.ErrPermission) {
			t.Fatalf("unreadable journal: %v", err)
		}
	}
	os.Chmod(locked, 0o644)
	if persistent, err := journal.CheckAccess([]string{disk, mem}); err != nil || !persistent {
		t.Fatalf("disk journal: %v %v", persistent, err)
	}
}
