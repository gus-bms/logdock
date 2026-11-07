package tail

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

// watchOptions는 시각을 볼 때마다 시계를 1ms씩 움직여 Poll마다 폴더를 훑게 한다. 탐색 주기를
// 기다리지 않고 시험한다.
func watchOptions(c *clock) Options {
	o := testOptions(c)
	o.ScanInterval = time.Millisecond
	o.IdleClose = 10 * time.Second
	o.Now = func() time.Time {
		c.add(time.Millisecond)
		return c.now
	}
	return o
}

func TestWatcherStartsExistingFilesAtEnd(t *testing.T) {
	dir := t.TempDir()
	a := openAppend(t, filepath.Join(dir, "app-1.log"), "old\n")
	b := openAppend(t, filepath.Join(dir, "app-2.log"), "half")
	openAppend(t, filepath.Join(dir, "other.txt"), "not matched\n")
	if err := os.Mkdir(filepath.Join(dir, "app-sub.log"), 0o755); err != nil {
		t.Fatal(err)
	}
	// 폴더 밖 파일을 가리키는 링크는 이름이 맞아도 따라가지 않는다.
	outside := filepath.Join(t.TempDir(), "outside.log")
	openAppend(t, outside, "outside\n")
	if err := os.Symlink(outside, filepath.Join(dir, "app-link.log")); err != nil {
		t.Fatal(err)
	}

	w := NewWatcher(filepath.Join(dir, "app-*.log"), watchOptions(newClock()))
	defer w.Close()
	r := newRecorder(t)
	r.poll(w)
	if got := r.kinds(); !equalKinds(got, []BoundaryKind{InitialTail, InitialTail}) {
		t.Fatalf("boundaries %v", got)
	}
	if !r.bounds[0].AtLineStart || r.bounds[1].AtLineStart {
		t.Fatalf("at line start: %v %v", r.bounds[0].AtLineStart, r.bounds[1].AtLineStart)
	}
	write(t, a, "new-a\n")
	write(t, b, " rest\nnew-b\n")
	r.poll(w)
	if got := r.text(idOf(t, filepath.Join(dir, "app-1.log"))); got != "new-a\n" {
		t.Fatalf("app-1 %q", got)
	}
	if got := r.text(idOf(t, filepath.Join(dir, "app-2.log"))); got != " rest\nnew-b\n" {
		t.Fatalf("app-2 %q", got)
	}
	if len(r.data) != 2 {
		t.Fatalf("read %d files, want 2", len(r.data))
	}
}

func TestWatcherReadsNewFileFromHead(t *testing.T) {
	dir := t.TempDir()
	w := NewWatcher(filepath.Join(dir, "*.log"), watchOptions(newClock()))
	defer w.Close()
	r := newRecorder(t)
	r.poll(w)
	path := filepath.Join(dir, "new.log")
	openAppend(t, path, "first\n")
	r.poll(w)
	if got := r.kinds(); !equalKinds(got, []BoundaryKind{NewFileHead}) {
		t.Fatalf("boundaries %v", got)
	}
	if got := r.text(idOf(t, path)); got != "first\n" {
		t.Fatalf("read %q", got)
	}
}

func TestWatcherMissingFolderMeansLaterFilesAreNew(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "later")
	w := NewWatcher(filepath.Join(dir, "*.log"), watchOptions(newClock()))
	defer w.Close()
	if _, err := w.Poll(); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("Poll error %v, want not exist", err)
	}
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "app.log")
	openAppend(t, path, "first\n")
	r := newRecorder(t)
	r.poll(w)
	if got := r.kinds(); !equalKinds(got, []BoundaryKind{NewFileHead}) {
		t.Fatalf("boundaries %v", got)
	}
	if got := r.text(idOf(t, path)); got != "first\n" {
		t.Fatalf("read %q", got)
	}
}

func TestWatcherFollowsRenameInsideRule(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	a := openAppend(t, path, "old\n")
	id := idOf(t, path)
	w := NewWatcher(filepath.Join(dir, "app*.log"), watchOptions(newClock()))
	defer w.Close()
	r := newRecorder(t)
	r.poll(w)
	moved := filepath.Join(dir, "app-1.log")
	mustRename(t, path, moved)
	write(t, a, "after\n")
	r.poll(w)
	if got := r.kinds(); !equalKinds(got, []BoundaryKind{InitialTail}) {
		t.Fatalf("boundaries %v (a renamed file is not a new file)", got)
	}
	if got := r.text(id); got != "after\n" {
		t.Fatalf("read %q", got)
	}
	if got := w.Path(id); got != moved {
		t.Fatalf("path %q, want %q", got, moved)
	}
}

func TestWatcherDrainsFileRenamedOutOfRule(t *testing.T) {
	clk := newClock()
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	old := openAppend(t, path, "")
	oldID := idOf(t, path)
	w := NewWatcher(filepath.Join(dir, "*.log"), watchOptions(clk))
	defer w.Close()
	r := newRecorder(t)
	r.poll(w)
	mustRename(t, path, filepath.Join(dir, "app.log.1"))
	write(t, old, "late\n") // 앱이 아직 다시 열지 않아 옛 파일에 쓴다
	cur := openAppend(t, path, "n1\n")
	r.poll(w)
	if got := r.text(oldID); got != "late\n" {
		t.Fatalf("old file %q", got)
	}
	if got := r.text(idOf(t, path)); got != "n1\n" {
		t.Fatalf("new file %q", got)
	}
	if len(r.ends) != 0 {
		t.Fatal("old file let go before it was quiet")
	}
	clk.add(11 * time.Second)
	write(t, cur, "n2\n")
	r.poll(w)
	if !slices.Equal(r.ends, []FileID{oldID}) {
		t.Fatalf("ended %v, want the old file", r.ends)
	}
	if got := r.text(idOf(t, path)); got != "n1\nn2\n" {
		t.Fatalf("new file %q", got)
	}
}

func TestWatcherDeletedFileHeldTooLongReportsLoss(t *testing.T) {
	clk := newClock()
	dir := t.TempDir()
	opt := watchOptions(clk)
	opt.MaxReadBytes = 4
	w := NewWatcher(filepath.Join(dir, "*.log"), opt)
	defer w.Close()
	r := newRecorder(t)
	r.poll(w)
	path := filepath.Join(dir, "app.log")
	openAppend(t, path, "0123456789abcdefghij")
	id := idOf(t, path)
	r.poll(w) // 4바이트
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	r.poll(w) // 8바이트. 지워진 것을 안다
	clk.add(2 * time.Minute)
	r.poll(w) // 12바이트, 보유 시간이 지나 남은 8바이트를 잃은 것으로 알린다
	last := r.last()
	if last.Boundary != GoneBeforeRead || last.SkippedBytes != 8 || last.Offset != 12 {
		t.Fatalf("last boundary %+v", last)
	}
	if !slices.Equal(r.ends, []FileID{id}) {
		t.Fatalf("ended %v", r.ends)
	}
	if w.OpenFiles() != 0 {
		t.Fatal("deleted file still open")
	}
}

func TestWatcherCatchesTruncation(t *testing.T) {
	dir := t.TempDir()
	w := NewWatcher(filepath.Join(dir, "*.log"), watchOptions(newClock()))
	defer w.Close()
	r := newRecorder(t)
	r.poll(w)
	path := filepath.Join(dir, "app.log")
	a := openAppend(t, path, "before\n")
	r.poll(w)
	if err := os.Truncate(path, 0); err != nil {
		t.Fatal(err)
	}
	write(t, a, "new\n")
	r.poll(w)
	if got := r.kinds(); !equalKinds(got, []BoundaryKind{NewFileHead, Truncated}) {
		t.Fatalf("boundaries %v", got)
	}
	if got := r.text(idOf(t, path)); got != "before\nnew\n" {
		t.Fatalf("read %q", got)
	}
}

func TestWatcherClosesIdleFilesAndReopensOnChange(t *testing.T) {
	clk := newClock()
	dir := t.TempDir()
	w := NewWatcher(filepath.Join(dir, "*.log"), watchOptions(clk))
	defer w.Close()
	r := newRecorder(t)
	r.poll(w)
	path := filepath.Join(dir, "app.log")
	a := openAppend(t, path, "one\n")
	r.poll(w)
	clk.add(11 * time.Second)
	r.poll(w)
	if n := w.OpenFiles(); n != 0 {
		t.Fatalf("%d files open after idle", n)
	}
	write(t, a, "two\n")
	r.poll(w)
	if got := r.text(idOf(t, path)); got != "one\ntwo\n" {
		t.Fatalf("read %q", got)
	}
	if n := w.OpenFiles(); n != 1 {
		t.Fatalf("%d files open after change", n)
	}
	if got := r.kinds(); !equalKinds(got, []BoundaryKind{NewFileHead}) {
		t.Fatalf("boundaries %v (reopening is not a new file)", got)
	}
}

func TestWatcherFindsClosedFileRenamedOutOfRule(t *testing.T) {
	clk := newClock()
	dir := t.TempDir()
	w := NewWatcher(filepath.Join(dir, "*.log"), watchOptions(clk))
	defer w.Close()
	r := newRecorder(t)
	r.poll(w)
	path := filepath.Join(dir, "app.log")
	a := openAppend(t, path, "one\n")
	id := idOf(t, path)
	r.poll(w)
	clk.add(11 * time.Second)
	r.poll(w) // 닫아 둔다
	write(t, a, "last\n")
	mustRename(t, path, filepath.Join(dir, "app.log.1"))
	r.poll(w)
	if got := r.text(id); got != "one\nlast\n" {
		t.Fatalf("read %q", got)
	}
	clk.add(11 * time.Second)
	r.poll(w)
	if !slices.Equal(r.ends, []FileID{id}) {
		t.Fatalf("ended %v", r.ends)
	}
}

func TestWatcherWaitsForOpenSlot(t *testing.T) {
	clk := newClock()
	dir := t.TempDir()
	opt := watchOptions(clk)
	opt.MaxOpen = 1
	w := NewWatcher(filepath.Join(dir, "*.log"), opt)
	defer w.Close()
	r := newRecorder(t)
	r.poll(w)
	pa, pb := filepath.Join(dir, "a.log"), filepath.Join(dir, "b.log")
	openAppend(t, pa, "a1\n")
	openAppend(t, pb, "b1\n")
	r.poll(w)
	if !w.Limited() || w.OpenFiles() != 1 {
		t.Fatalf("limited %v, open %d", w.Limited(), w.OpenFiles())
	}
	if got := r.text(idOf(t, pa)); got != "a1\n" {
		t.Fatalf("a %q", got)
	}
	clk.add(11 * time.Second)
	r.poll(w) // a를 닫아 자리를 낸다
	r.poll(w) // b를 열어 읽는다
	if got := r.text(idOf(t, pb)); got != "b1\n" {
		t.Fatalf("b %q", got)
	}
	if w.Limited() {
		t.Fatal("still limited")
	}
	if got := r.kinds(); !equalKinds(got, []BoundaryKind{NewFileHead, NewFileHead}) {
		t.Fatalf("boundaries %v", got)
	}
}

func TestWatcherFileLimitStartsSkippedExistingFileAtEnd(t *testing.T) {
	clk := newClock()
	dir := t.TempDir()
	pa, pb := filepath.Join(dir, "a.log"), filepath.Join(dir, "b.log")
	openAppend(t, pa, "a-old\n")
	b := openAppend(t, pb, "b-old\n")
	opt := watchOptions(clk)
	opt.MaxFiles = 1
	w := NewWatcher(filepath.Join(dir, "*.log"), opt)
	defer w.Close()
	r := newRecorder(t)
	r.poll(w)
	if !w.Limited() || !w.Unsure() {
		t.Fatalf("limited %v, unsure %v", w.Limited(), w.Unsure())
	}
	write(t, b, "b-mid\n") // 따라가지 못하는 동안 쓰였다
	if err := os.Remove(pa); err != nil {
		t.Fatal(err)
	}
	r.poll(w)
	clk.add(2 * time.Second)
	r.poll(w) // a를 놓는다
	r.poll(w) // 자리가 나서 b를 따라간다
	// b는 최초 연결 때 있던 파일이라 처음부터 읽으면 연결 전 로그가 섞인다. 끝 위치를 그때
	// 확정하지 못했으므로 지금 끝에서 시작하고 건너뛴 크기를 알린다.
	if got := r.kinds(); !equalKinds(got, []BoundaryKind{InitialTail, NewFileTail}) {
		t.Fatalf("boundaries %v", got)
	}
	if last := r.last(); last.SkippedBytes != int64(len("b-old\nb-mid\n")) || !last.AtLineStart {
		t.Fatalf("new file tail %+v", last)
	}
	write(t, b, "b-new\n")
	r.poll(w)
	if got := r.text(idOf(t, pb)); got != "b-new\n" {
		t.Fatalf("b %q", got)
	}
	if w.Limited() || w.Unsure() {
		t.Fatalf("limited %v, unsure %v", w.Limited(), w.Unsure())
	}
}

// restarted는 w의 상태를 저장하고 닫은 뒤, between을 실행하고 같은 상태로 새 Watcher를 연다.
func restarted(t *testing.T, w *Watcher, pattern string, opt Options, sameRule bool, between func([]Saved) []Saved) *Watcher {
	t.Helper()
	saved := w.Files()
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if between != nil {
		saved = between(saved)
	}
	w2 := NewWatcher(pattern, opt)
	w2.Restore(Resume{Files: saved, SameRule: sameRule})
	t.Cleanup(func() { w2.Close() })
	return w2
}

func TestWatcherRestoreResumesKnownFilesAndReadsNewOnesFromHead(t *testing.T) {
	clk := newClock()
	dir := t.TempDir()
	pattern := filepath.Join(dir, "*.log")
	pa := filepath.Join(dir, "a.log")
	a := openAppend(t, pa, "old\n")
	w := NewWatcher(pattern, watchOptions(clk))
	r := newRecorder(t)
	r.poll(w)
	write(t, a, "a1\n")
	r.poll(w)
	w2 := restarted(t, w, pattern, watchOptions(clk), true, func(s []Saved) []Saved {
		write(t, a, "a2\n")                                // 꺼져 있던 사이 쓰였다
		openAppend(t, filepath.Join(dir, "c.log"), "c1\n") // 꺼져 있던 사이 생겼다
		return s
	})
	r2 := newRecorder(t)
	r2.poll(w2)
	if got := r2.kinds(); !equalKinds(got, []BoundaryKind{NewFileHead}) {
		t.Fatalf("boundaries %v", got)
	}
	if got := r2.text(idOf(t, pa)); got != "a2\n" {
		t.Fatalf("a %q", got)
	}
	if got := r2.text(idOf(t, filepath.Join(dir, "c.log"))); got != "c1\n" {
		t.Fatalf("c %q", got)
	}
}

func TestWatcherRestoreWithChangedRuleStartsNewFilesAtEnd(t *testing.T) {
	clk := newClock()
	dir := t.TempDir()
	pa := filepath.Join(dir, "a.log")
	openAppend(t, pa, "old\n")
	pc := filepath.Join(dir, "c.txt")
	c := openAppend(t, pc, "c-old\n") // 예전 규칙에는 들지 않던 파일
	w := NewWatcher(filepath.Join(dir, "*.log"), watchOptions(clk))
	r := newRecorder(t)
	r.poll(w)
	w2 := restarted(t, w, filepath.Join(dir, "*.*"), watchOptions(clk), false, nil)
	r2 := newRecorder(t)
	r2.poll(w2)
	if got := r2.kinds(); !equalKinds(got, []BoundaryKind{NewFileTail}) {
		t.Fatalf("boundaries %v", got)
	}
	if last := r2.last(); last.File != idOf(t, pc) || last.SkippedBytes != int64(len("c-old\n")) {
		t.Fatalf("new file tail %+v", last)
	}
	write(t, c, "c-new\n")
	r2.poll(w2)
	if got := r2.text(idOf(t, pc)); got != "c-new\n" {
		t.Fatalf("c %q", got)
	}
}

func TestWatcherRestoreHandlesReplacedAndMissingFiles(t *testing.T) {
	clk := newClock()
	dir := t.TempDir()
	pattern := filepath.Join(dir, "*.log")
	pa, pb, pc := filepath.Join(dir, "a.log"), filepath.Join(dir, "b.log"), filepath.Join(dir, "c.log")
	openAppend(t, pa, "a-old\n")
	openAppend(t, pb, "b-old\n")
	openAppend(t, pc, "c-old\n")
	ia, ib, ic := idOf(t, pa), idOf(t, pb), idOf(t, pc)
	w := NewWatcher(pattern, watchOptions(clk))
	r := newRecorder(t)
	r.poll(w)
	w2 := restarted(t, w, pattern, watchOptions(clk), true, func(s []Saved) []Saved {
		// a는 같은 inode에 다른 내용이 쓰였다. b는 덜 읽은 채, c는 다 읽은 채 지워졌다.
		if err := os.WriteFile(pa, []byte("replaced content\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		for i := range s {
			if s[i].File == ib {
				s[i].Offset = 2
			}
		}
		for _, p := range []string{pb, pc} {
			if err := os.Remove(p); err != nil {
				t.Fatal(err)
			}
		}
		return s
	})
	r2 := newRecorder(t)
	r2.poll(w2)
	if got := r2.kinds(); !equalKinds(got, []BoundaryKind{GoneBeforeRead, IdentityReused}) {
		t.Fatalf("boundaries %v", got)
	}
	if b := r2.bounds[0]; b.File != ib || b.SkippedBytes != Unknown {
		t.Fatalf("gone %+v", b)
	}
	if !slices.Equal(r2.ends, []FileID{ib, ic}) {
		t.Fatalf("ended %v", r2.ends)
	}
	if got := r2.text(ia); got != "replaced content\n" {
		t.Fatalf("a %q", got)
	}
}
