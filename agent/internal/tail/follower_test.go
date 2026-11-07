package tail

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// clock은 시험에서 시간을 직접 움직인다. 회전 유예와 삭제 파일 보유 시간을 기다리지 않고 시험한다.
type clock struct{ now time.Time }

func newClock() *clock               { return &clock{now: time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)} }
func (c *clock) Now() time.Time      { return c.now }
func (c *clock) add(d time.Duration) { c.now = c.now.Add(d) }
func testOptions(c *clock) Options {
	return Options{RotateGrace: time.Second, MaxHoldDeleted: time.Minute, Now: c.Now}
}

// recorder는 Poll 결과를 파일별로 모으고, 같은 파일의 바이트가 빠지거나 겹치면 바로 실패시킨다.
type recorder struct {
	t      *testing.T
	data   map[FileID]*bytes.Buffer
	next   map[FileID]int64
	bounds []Chunk
	ends   []FileID
}

func newRecorder(t *testing.T) *recorder {
	return &recorder{t: t, data: map[FileID]*bytes.Buffer{}, next: map[FileID]int64{}}
}

// poller는 Follower와 Watcher다.
type poller interface {
	Poll() ([]Chunk, error)
}

func (r *recorder) poll(f poller) {
	r.t.Helper()
	chunks, err := f.Poll()
	if err != nil {
		r.t.Fatalf("Poll: %v", err)
	}
	for _, c := range chunks {
		if c.End {
			r.ends = append(r.ends, c.File)
			delete(r.next, c.File)
			continue
		}
		if c.Boundary != "" {
			r.bounds = append(r.bounds, c)
			r.next[c.File] = c.Offset
			continue
		}
		if want, ok := r.next[c.File]; ok && c.Offset != want {
			r.t.Fatalf("%v: chunk at offset %d, want %d (bytes skipped or repeated)", c.File, c.Offset, want)
		}
		r.next[c.File] = c.Offset + int64(len(c.Data))
		if r.data[c.File] == nil {
			r.data[c.File] = &bytes.Buffer{}
		}
		r.data[c.File].Write(c.Data)
	}
}

func (r *recorder) text(id FileID) string {
	if b := r.data[id]; b != nil {
		return b.String()
	}
	return ""
}

func (r *recorder) kinds() []BoundaryKind {
	var ks []BoundaryKind
	for _, b := range r.bounds {
		ks = append(ks, b.Boundary)
	}
	return ks
}

func (r *recorder) last() Chunk {
	r.t.Helper()
	if len(r.bounds) == 0 {
		r.t.Fatal("no boundary")
	}
	return r.bounds[len(r.bounds)-1]
}

// openAppend는 로그를 쓰는 앱처럼 O_APPEND로 파일을 열고 내용을 쓴다. 돌려준 핸들로 계속 쓴다.
func openAppend(t *testing.T, path, s string) *os.File {
	t.Helper()
	w, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { w.Close() })
	write(t, w, s)
	return w
}

func write(t *testing.T, w *os.File, s string) {
	t.Helper()
	if _, err := w.WriteString(s); err != nil {
		t.Fatal(err)
	}
}

func idOf(t *testing.T, path string) FileID {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	id, ok := fileIDOf(fi)
	if !ok {
		t.Fatal("no file id")
	}
	return id
}

func mustRename(t *testing.T, from, to string) {
	t.Helper()
	if err := os.Rename(from, to); err != nil {
		t.Fatal(err)
	}
}

func equalKinds(a, b []BoundaryKind) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestInitialTailStartsAtEndOfExistingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	w := openAppend(t, path, "old1\nold2\n")
	f := New(path, testOptions(newClock()))
	defer f.Close()
	r := newRecorder(t)

	r.poll(f)
	b := r.last()
	if b.Boundary != InitialTail || b.Offset != 10 || !b.AtLineStart {
		t.Fatalf("got %+v, want initial_tail at 10 on a line start", b)
	}
	write(t, w, "new1\n")
	r.poll(f)
	if got := r.text(idOf(t, path)); got != "new1\n" {
		t.Fatalf("read %q, want only the line written after connecting", got)
	}
}

func TestInitialTailReportsMidLineStart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	openAppend(t, path, "old\npart")
	f := New(path, testOptions(newClock()))
	defer f.Close()
	r := newRecorder(t)

	r.poll(f)
	if b := r.last(); b.Boundary != InitialTail || b.AtLineStart {
		t.Fatalf("got %+v, want initial_tail not on a line start (D02 skips the rest of that line)", b)
	}
}

func TestFileCreatedAfterConnectingIsReadFromHead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	f := New(path, testOptions(newClock()))
	defer f.Close()
	r := newRecorder(t)

	r.poll(f) // 파일이 아직 없다
	openAppend(t, path, "a\nb\n")
	r.poll(f)
	if !equalKinds(r.kinds(), []BoundaryKind{NewFileHead}) || r.text(idOf(t, path)) != "a\nb\n" {
		t.Fatalf("kinds %v text %q, want new_file_head and the whole file", r.kinds(), r.text(idOf(t, path)))
	}
}

func TestRenameRotationFinishesOldFileBeforeSwitching(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	clk := newClock()
	w := openAppend(t, path, "x\n")
	f := New(path, testOptions(clk))
	defer f.Close()
	r := newRecorder(t)

	r.poll(f)
	write(t, w, "1\n")
	r.poll(f)
	oldID := idOf(t, path)

	mustRename(t, path, path+".1")
	openAppend(t, path, "2\n")
	newID := idOf(t, path)
	write(t, w, "late\n") // 앱이 로그를 다시 열기 전까지 옛 파일에 쓴다
	r.poll(f)
	if r.text(oldID) != "1\nlate\n" || r.text(newID) != "" {
		t.Fatalf("old %q new %q, want the old file drained and the new one not started yet", r.text(oldID), r.text(newID))
	}

	clk.add(time.Second) // 옛 파일이 조용해졌다
	r.poll(f)
	b := r.last()
	if b.Boundary != Rotated || b.File != newID || b.PrevFile != oldID || !b.OrderConfirmed {
		t.Fatalf("got %+v, want rotated from the old file with confirmed order", b)
	}
	if r.text(newID) != "2\n" {
		t.Fatalf("new file read %q, want it from the head", r.text(newID))
	}
}

func TestTwoRotationsBeforeSwitchingLoseNothing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	clk := newClock()
	w := openAppend(t, path, "x\n")
	f := New(path, testOptions(clk))
	defer f.Close()
	r := newRecorder(t)

	r.poll(f)
	write(t, w, "1\n")
	r.poll(f)
	a := idOf(t, path)

	mustRename(t, path, path+".1")
	openAppend(t, path, "2\n")
	b := idOf(t, path)
	r.poll(f) // b를 미리 열어 둔다

	// 옛 파일 a를 다 읽기 전에 b도 회전된다(logrotate가 번호를 하나씩 민다)
	mustRename(t, path+".1", path+".2")
	mustRename(t, path, path+".1")
	openAppend(t, path, "3\n")
	c := idOf(t, path)

	clk.add(time.Second)
	r.poll(f) // a → b
	clk.add(time.Second)
	r.poll(f) // b → c
	if r.text(a) != "1\n" || r.text(b) != "2\n" || r.text(c) != "3\n" {
		t.Fatalf("a %q b %q c %q, want every file read once", r.text(a), r.text(b), r.text(c))
	}
	if !equalKinds(r.kinds(), []BoundaryKind{InitialTail, Rotated, Rotated}) {
		t.Fatalf("kinds %v", r.kinds())
	}
}

func TestCopyTruncateRestartsFromZero(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	w := openAppend(t, path, "x\n")
	f := New(path, testOptions(newClock()))
	defer f.Close()
	r := newRecorder(t)

	r.poll(f)
	write(t, w, "a\nb\n")
	r.poll(f)
	if err := os.Truncate(path, 0); err != nil {
		t.Fatal(err)
	}
	write(t, w, "c\n") // O_APPEND라 잘린 파일의 처음부터 쓴다
	r.poll(f)
	b := r.last()
	if b.Boundary != Truncated || b.SkippedBytes != Unknown {
		t.Fatalf("got %+v, want truncated with unknown loss", b)
	}
	if got := r.text(idOf(t, path)); got != "a\nb\nc\n" {
		t.Fatalf("read %q", got)
	}
}

func TestRewriteBiggerThanOffsetIsCaughtByFingerprint(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	w := openAppend(t, path, "AAAA\n")
	f := New(path, testOptions(newClock()))
	defer f.Close()
	r := newRecorder(t)

	r.poll(f)
	write(t, w, "B\n")
	r.poll(f) // 읽은 위치 7
	if err := os.Truncate(path, 0); err != nil {
		t.Fatal(err)
	}
	write(t, w, "XXXXXXXXXXXX\n") // 13바이트. 크기만 보면 잘린 줄 모른다
	r.poll(f)
	if b := r.last(); b.Boundary != Truncated {
		t.Fatalf("got %+v, want truncated", b)
	}
	if got := r.text(idOf(t, path)); got != "B\nXXXXXXXXXXXX\n" {
		t.Fatalf("read %q, want the rewritten file from its head", got)
	}
}

func TestDeletedFileIsDrainedThenReleased(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	clk := newClock()
	w := openAppend(t, path, "x\n")
	f := New(path, testOptions(clk))
	defer f.Close()
	r := newRecorder(t)

	r.poll(f)
	old := idOf(t, path)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	write(t, w, "1\n") // 지워진 파일에도 앱은 계속 쓸 수 있다
	r.poll(f)
	clk.add(time.Second)
	r.poll(f) // 다 읽었고 조용하므로 닫는다
	openAppend(t, path, "2\n")
	r.poll(f)
	b := r.last()
	if r.text(old) != "1\n" || b.Boundary != Rotated || b.PrevFile != old || !b.OrderConfirmed {
		t.Fatalf("old %q last %+v, want the deleted file drained and the next one rotated in", r.text(old), b)
	}
	if got := r.text(idOf(t, path)); got != "2\n" {
		t.Fatalf("new file read %q", got)
	}
}

func TestDeletedFileHeldTooLongReportsSkippedBytes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	clk := newClock()
	opt := testOptions(clk)
	opt.MaxReadBytes = 4 // 한 번에 조금씩만 읽어 다 읽기 전에 보유 시간이 끝나게 한다
	w := openAppend(t, path, "x\n")
	f := New(path, opt)
	defer f.Close()
	r := newRecorder(t)

	r.poll(f)
	old := idOf(t, path)
	const body = "aaaa\nbbbb\ncccc\ndddd\n"
	write(t, w, body)
	r.poll(f)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	r.poll(f)
	clk.add(time.Minute)
	r.poll(f)
	b := r.last()
	if b.Boundary != GoneBeforeRead || b.File != old {
		t.Fatalf("got %+v, want gone_before_read for the deleted file", b)
	}
	if read := int64(len(r.text(old))); read+b.SkippedBytes != int64(len(body)) {
		t.Fatalf("read %d + skipped %d, want %d: every byte is either read or counted as lost", read, b.SkippedBytes, len(body))
	}
}

func TestReadBudgetLimitsOnePoll(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	opt := testOptions(newClock())
	opt.MaxReadBytes = 5
	f := New(path, opt)
	defer f.Close()
	r := newRecorder(t)

	r.poll(f)
	openAppend(t, path, "0123456789\n\n")
	for _, want := range []int{5, 10, 12} {
		r.poll(f)
		if got := len(r.text(idOf(t, path))); got != want {
			t.Fatalf("read %d bytes so far, want %d", got, want)
		}
	}
}

func TestResumeSameFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	w := openAppend(t, path, "x\n")
	f1 := New(path, testOptions(newClock()))
	r1 := newRecorder(t)
	r1.poll(f1)
	write(t, w, "1\n")
	r1.poll(f1)
	pos, ok := f1.Position()
	if !ok {
		t.Fatal("no position")
	}
	f1.Close()

	write(t, w, "2\n") // 에이전트가 멈춘 사이에 쓰였다
	f2 := New(path, testOptions(newClock()))
	defer f2.Close()
	f2.Restore(pos)
	r2 := newRecorder(t)
	r2.poll(f2)
	if len(r2.bounds) != 0 || r2.text(idOf(t, path)) != "2\n" {
		t.Fatalf("kinds %v read %q, want to continue without a boundary", r2.kinds(), r2.text(idOf(t, path)))
	}
}

func TestResumeAfterRotationWhileStopped(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	clk := newClock()
	w := openAppend(t, path, "x\n")
	f1 := New(path, testOptions(clk))
	r1 := newRecorder(t)
	r1.poll(f1)
	write(t, w, "1\n")
	r1.poll(f1)
	pos, _ := f1.Position()
	f1.Close()
	old := idOf(t, path)

	write(t, w, "2\n")
	mustRename(t, path, path+".1")
	openAppend(t, path, "3\n")
	f2 := New(path, testOptions(clk))
	defer f2.Close()
	f2.Restore(pos)
	r2 := newRecorder(t)
	r2.poll(f2)
	clk.add(time.Second)
	r2.poll(f2)
	b := r2.last()
	if r2.text(old) != "2\n" || b.Boundary != Rotated || b.PrevFile != old || b.OrderConfirmed {
		t.Fatalf("old %q last %+v, want the rotated file finished and the order marked unconfirmed", r2.text(old), b)
	}
	if got := r2.text(idOf(t, path)); got != "3\n" {
		t.Fatalf("new file read %q", got)
	}
}

func TestResumeWhenSavedFileIsGone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	w := openAppend(t, path, "x\n") // 핸들을 열어 둬 inode 번호가 새 파일에 다시 쓰이지 않게 한다
	f1 := New(path, testOptions(newClock()))
	r1 := newRecorder(t)
	r1.poll(f1)
	write(t, w, "1\n")
	r1.poll(f1)
	pos, _ := f1.Position()
	f1.Close()

	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	openAppend(t, path, "3\n")
	f2 := New(path, testOptions(newClock()))
	defer f2.Close()
	f2.Restore(pos)
	r2 := newRecorder(t)
	r2.poll(f2)
	if !equalKinds(r2.kinds(), []BoundaryKind{GoneBeforeRead, Rotated}) {
		t.Fatalf("kinds %v", r2.kinds())
	}
	if gone := r2.bounds[0]; gone.File != pos.File || gone.SkippedBytes != Unknown {
		t.Fatalf("got %+v, want the saved file reported gone with unknown loss", gone)
	}
	if b := r2.last(); b.OrderConfirmed || r2.text(idOf(t, path)) != "3\n" {
		t.Fatalf("got %+v read %q", b, r2.text(idOf(t, path)))
	}
}

func TestResumeTreatsDifferentContentAsNewFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	openAppend(t, path, "AAAA\n")
	f1 := New(path, testOptions(newClock()))
	r1 := newRecorder(t)
	r1.poll(f1)
	pos, _ := f1.Position()
	f1.Close()

	pos.HeadSum[0] ^= 0xff // 같은 inode 번호를 다른 파일이 이어받은 상황을 흉내 낸다
	f2 := New(path, testOptions(newClock()))
	defer f2.Close()
	f2.Restore(pos)
	r2 := newRecorder(t)
	r2.poll(f2)
	if !equalKinds(r2.kinds(), []BoundaryKind{IdentityReused}) || r2.text(idOf(t, path)) != "AAAA\n" {
		t.Fatalf("kinds %v read %q, want identity_reused and the file from its head", r2.kinds(), r2.text(idOf(t, path)))
	}
}

func TestDirectoryIsRejected(t *testing.T) {
	f := New(t.TempDir(), testOptions(newClock()))
	defer f.Close()
	if _, err := f.Poll(); !errors.Is(err, ErrNotRegular) {
		t.Fatalf("got %v, want ErrNotRegular", err)
	}
}
