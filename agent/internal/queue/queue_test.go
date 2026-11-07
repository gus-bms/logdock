package queue

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func payloads(ss ...string) [][]byte {
	out := make([][]byte, len(ss))
	for i, s := range ss {
		out[i] = []byte(s)
	}
	return out
}

func mustOpen(t *testing.T, dir string, opt Options) *Queue {
	t.Helper()
	q, err := Open(dir, opt)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { q.Close() })
	return q
}

func mustAppend(t *testing.T, q *Queue, ss ...string) uint64 {
	t.Helper()
	first, err := q.Append(payloads(ss...))
	if err != nil {
		t.Fatalf("Append: %v", err)
	}
	return first
}

func segments(t *testing.T, dir string) []string {
	t.Helper()
	m, err := filepath.Glob(filepath.Join(dir, "seg-*.dat"))
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(m)
	return m
}

func readAll(t *testing.T, q *Queue, from uint64) []string {
	t.Helper()
	es, err := q.Read(from, 1<<20, 1000)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	var out []string
	for i, e := range es {
		if e.Seq != from+uint64(i) {
			t.Fatalf("entry %d has seq %d, want %d", i, e.Seq, from+uint64(i))
		}
		out = append(out, string(e.Payload))
	}
	return out
}

func equal(a, b []string) bool {
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

func TestAppendReadAckAndReopen(t *testing.T) {
	dir := t.TempDir()
	q := mustOpen(t, dir, Options{})
	if first := mustAppend(t, q, "a", "b", "c"); first != 1 {
		t.Fatalf("first seq %d, want 1", first)
	}
	if got := readAll(t, q, 1); !equal(got, []string{"a", "b", "c"}) {
		t.Fatalf("read %v", got)
	}
	if err := q.Ack(2); err != nil {
		t.Fatal(err)
	}
	if got := readAll(t, q, 3); !equal(got, []string{"c"}) {
		t.Fatalf("read after ack %v", got)
	}
	q.Close()

	q2 := mustOpen(t, dir, Options{})
	last, ok, err := q2.Last()
	if err != nil || !ok || last.Seq != 3 || string(last.Payload) != "c" {
		t.Fatalf("last %+v ok %v err %v", last, ok, err)
	}
	if q2.AckedThrough() != 2 || q2.NextSeq() != 4 {
		t.Fatalf("acked %d next %d, want 2 and 4", q2.AckedThrough(), q2.NextSeq())
	}
}

func TestTornTailIsCutOnOpen(t *testing.T) {
	dir := t.TempDir()
	q := mustOpen(t, dir, Options{})
	mustAppend(t, q, "a", "b")
	q.Close()

	// 길이 100짜리 기록을 쓰다가 10바이트에서 멈춘 상황
	seg := segments(t, dir)[0]
	f, err := os.OpenFile(seg, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	torn := appendFrame(nil, 3, make([]byte, 100))[:frameHeader+10]
	if _, err := f.Write(torn); err != nil {
		t.Fatal(err)
	}
	f.Close()

	q2 := mustOpen(t, dir, Options{})
	if q2.CutOnOpen() != int64(len(torn)) || q2.NextSeq() != 3 {
		t.Fatalf("cut %d next %d, want %d and 3", q2.CutOnOpen(), q2.NextSeq(), len(torn))
	}
	mustAppend(t, q2, "c")
	if got := readAll(t, q2, 1); !equal(got, []string{"a", "b", "c"}) {
		t.Fatalf("read %v", got)
	}
}

func TestHalfWrittenLastRecordIsCut(t *testing.T) {
	dir := t.TempDir()
	q := mustOpen(t, dir, Options{})
	mustAppend(t, q, "a", "b", "ccc")
	q.Close()
	seg := segments(t, dir)[0]
	fi, _ := os.Stat(seg)
	if err := os.Truncate(seg, fi.Size()-2); err != nil {
		t.Fatal(err)
	}
	q2 := mustOpen(t, dir, Options{})
	last, ok, _ := q2.Last()
	if !ok || last.Seq != 2 || q2.NextSeq() != 3 {
		t.Fatalf("last %+v next %d, want the half-written record dropped", last, q2.NextSeq())
	}
}

func TestLosingAnAckedRecordIsCorruption(t *testing.T) {
	dir := t.TempDir()
	q := mustOpen(t, dir, Options{})
	mustAppend(t, q, "a", "b", "ccc")
	if err := q.Ack(3); err != nil {
		t.Fatal(err)
	}
	q.Close()
	seg := segments(t, dir)[0]
	fi, _ := os.Stat(seg)
	if err := os.Truncate(seg, fi.Size()-2); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir, Options{}); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("got %v, want ErrCorrupt: re-reading an acked record would store it twice", err)
	}
}

func TestCorruptOlderSegmentIsReportedOnRead(t *testing.T) {
	dir := t.TempDir()
	q := mustOpen(t, dir, Options{SegmentBytes: 1}) // 기록마다 새 세그먼트
	mustAppend(t, q, "aaaa")
	mustAppend(t, q, "bbbb")
	q.Close()
	seg := segments(t, dir)[0]
	b, err := os.ReadFile(seg)
	if err != nil {
		t.Fatal(err)
	}
	b[len(b)-1] ^= 0xff
	if err := os.WriteFile(seg, b, 0o600); err != nil {
		t.Fatal(err)
	}
	q2 := mustOpen(t, dir, Options{SegmentBytes: 1})
	if _, err := q2.Read(1, 1<<20, 10); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("got %v, want ErrCorrupt", err)
	}
}

func TestAckDeletesFinishedSegmentsButKeepsTheLast(t *testing.T) {
	dir := t.TempDir()
	q := mustOpen(t, dir, Options{SegmentBytes: 1})
	mustAppend(t, q, "a")
	mustAppend(t, q, "b")
	mustAppend(t, q, "c")
	if n := len(segments(t, dir)); n != 3 {
		t.Fatalf("%d segments, want 3", n)
	}
	before := q.Used()
	if err := q.Ack(3); err != nil {
		t.Fatal(err)
	}
	if n := len(segments(t, dir)); n != 1 {
		t.Fatalf("%d segments after ack, want only the last one kept", n)
	}
	if q.Used() >= before {
		t.Fatalf("used %d, want less than %d", q.Used(), before)
	}
	if last, ok, _ := q.Last(); !ok || string(last.Payload) != "c" {
		t.Fatalf("last %+v, want c kept for its restart position", last)
	}
}

// 한 번에 쓴 기록들이 한 세그먼트에 들어가면, 모두 수신 확인돼도 그 세그먼트는 재시작 위치 때문에
// 남는다. 읽기 재개 판단은 이 바이트를 세지 않아야 한다(D01, 멈춘 채 다시 시작하지 않는 문제).
func TestUnackedIgnoresAckedSegmentKeptForRestart(t *testing.T) {
	q := mustOpen(t, t.TempDir(), Options{SegmentBytes: 1})
	if _, err := q.Append([][]byte{[]byte("a"), []byte("b"), []byte("c")}); err != nil {
		t.Fatal(err)
	}
	if q.Unacked() != q.Used() || q.Used() == 0 {
		t.Fatalf("before ack: unacked %d used %d", q.Unacked(), q.Used())
	}
	if err := q.Ack(2); err != nil {
		t.Fatal(err)
	}
	if q.Unacked() != q.Used() {
		t.Fatalf("partly acked segment must still count: unacked %d used %d", q.Unacked(), q.Used())
	}
	if err := q.Ack(3); err != nil {
		t.Fatal(err)
	}
	if q.Used() == 0 || q.Unacked() != 0 {
		t.Fatalf("after full ack: unacked %d used %d", q.Unacked(), q.Used())
	}
	mustAppend(t, q, "d")
	if q.Unacked() == 0 || q.Unacked() >= q.Used() {
		t.Fatalf("new record: unacked %d used %d", q.Unacked(), q.Used())
	}
}

func TestUnknownFormatIsLeftAlone(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, stateFile), []byte(`{"format":99,"acked_through":5}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir, Options{}); !errors.Is(err, ErrUnsupportedFormat) {
		t.Fatalf("got %v, want ErrUnsupportedFormat", err)
	}

	dir2 := t.TempDir()
	seg := filepath.Join(dir2, segName(1))
	if err := os.WriteFile(seg, []byte("LDQ9something"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir2, Options{}); !errors.Is(err, ErrUnsupportedFormat) {
		t.Fatalf("got %v, want ErrUnsupportedFormat", err)
	}
	if _, err := os.Stat(seg); err != nil {
		t.Fatalf("segment of an unknown format must not be deleted: %v", err)
	}
}

func TestAckBeyondEndIsRejected(t *testing.T) {
	q := mustOpen(t, t.TempDir(), Options{})
	mustAppend(t, q, "a")
	if err := q.Ack(2); !errors.Is(err, ErrAckBeyondEnd) {
		t.Fatalf("got %v, want ErrAckBeyondEnd", err)
	}
}

func TestReadLimits(t *testing.T) {
	q := mustOpen(t, t.TempDir(), Options{})
	mustAppend(t, q, "xxxx", "xxxx", "xxxx", "xxxx", "xxxx")
	for _, c := range []struct{ maxBytes, maxCount, want int }{
		{8, 100, 2},
		{1, 100, 1}, // 첫 기록은 크기와 상관없이 하나는 준다
		{100, 3, 3},
	} {
		es, err := q.Read(1, c.maxBytes, c.maxCount)
		if err != nil || len(es) != c.want {
			t.Fatalf("Read(maxBytes %d, maxCount %d) = %d entries, err %v; want %d", c.maxBytes, c.maxCount, len(es), err, c.want)
		}
	}
}

func TestSnapshotKeepsLaterRecordsUntilTheNextSnapshot(t *testing.T) {
	dir := t.TempDir()
	opt := Options{SegmentBytes: 1, Snapshots: true}
	q := mustOpen(t, dir, opt)
	for _, s := range []string{"a", "b", "c", "d"} {
		mustAppend(t, q, s)
	}
	if err := q.Ack(4); err != nil {
		t.Fatal(err)
	}
	// 스냅샷이 없으면 재시작 때 기록을 처음부터 다시 읽어야 하므로 수신 확인돼도 지우지 않는다.
	if n := len(segments(t, dir)); n != 4 {
		t.Fatalf("%d segments, want all 4 kept before any snapshot", n)
	}
	if err := q.SaveSnapshot(2, []byte(`{"files":2}`)); err != nil {
		t.Fatal(err)
	}
	if n := len(segments(t, dir)); n != 2 {
		t.Fatalf("%d segments, want 2 (records after the snapshot)", n)
	}
	q.Close()

	q = mustOpen(t, dir, opt)
	through, data, ok, err := q.Snapshot()
	if err != nil || !ok || through != 2 || string(data) != `{"files":2}` {
		t.Fatalf("snapshot %d %q %v %v", through, data, ok, err)
	}
	if got := readAll(t, q, 3); !equal(got, []string{"c", "d"}) {
		t.Fatalf("records after snapshot %v", got)
	}
	mustAppend(t, q, "e")
	if err := q.Ack(5); err != nil {
		t.Fatal(err)
	}
	if n := len(segments(t, dir)); n != 3 {
		t.Fatalf("%d segments, want 3 kept after reopening", n)
	}
	if err := q.SaveSnapshot(1, nil); err == nil {
		t.Fatal("snapshot going backwards was accepted")
	}
	if err := q.SaveSnapshot(6, nil); err == nil {
		t.Fatal("snapshot beyond the last record was accepted")
	}
}

func TestSnapshotRequiresTheOption(t *testing.T) {
	q := mustOpen(t, t.TempDir(), Options{})
	if err := q.SaveSnapshot(0, []byte(`{}`)); err == nil {
		t.Fatal("snapshot accepted without Options.Snapshots")
	}
}
