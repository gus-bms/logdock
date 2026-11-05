package assemble

import (
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gus-bms/logdock/agent/internal/tail"
)

var (
	fileA = tail.FileID{Dev: 1, Ino: 10}
	fileB = tail.FileID{Dev: 1, Ino: 11}
	start = regexp.MustCompile(`^\d{4}-\d{2}-\d{2} `)
)

type clock struct{ now time.Time }

func (c *clock) Now() time.Time      { return c.now }
func (c *clock) add(d time.Duration) { c.now = c.now.Add(d) }

func newAssembler(f Format, maxBytes int, clk *clock) *Assembler {
	var p *regexp.Regexp
	if f == Multiline {
		p = start
	}
	return New(Options{Format: f, StartPattern: p, MaxEventBytes: maxBytes, MaxWait: 5 * time.Second, Now: clk.Now})
}

func newClock() *clock { return &clock{now: time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)} }

func data(file tail.FileID, off int64, s string) tail.Chunk {
	return tail.Chunk{File: file, Offset: off, Data: []byte(s)}
}

func boundary(kind tail.BoundaryKind, file tail.FileID, off int64, atLineStart bool) tail.Chunk {
	return tail.Chunk{File: file, Offset: off, Boundary: kind, AtLineStart: atLineStart}
}

// summary는 기록을 비교하기 쉬운 문자열로 바꾼다. 이벤트는 본문과 위치를 함께 본다.
func summary(rs []Record) []string {
	var out []string
	for _, r := range rs {
		switch r.Kind {
		case Event:
			out = append(out, "event["+itoa(r.Offset)+":"+itoa(r.End)+"] "+string(r.Body))
		case Rejected:
			out = append(out, "rejected["+itoa(r.Offset)+":"+itoa(r.End)+"] "+r.Reason)
		case Boundary:
			out = append(out, "boundary "+string(r.Chunk.Boundary))
		}
	}
	return out
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func expect(t *testing.T, got []Record, want ...string) {
	t.Helper()
	s := summary(got)
	if strings.Join(s, "\n") != strings.Join(want, "\n") {
		t.Fatalf("got\n  %s\nwant\n  %s", strings.Join(s, "\n  "), strings.Join(want, "\n  "))
	}
}

func TestTextLinesBecomeEventsAndWaitForNewline(t *testing.T) {
	a := newAssembler(Text, 100, newClock())
	expect(t, a.Push(boundary(tail.NewFileHead, fileA, 0, true)), "boundary new_file_head")
	expect(t, a.Push(data(fileA, 0, "one\r\ntw")), "event[0:5] one")
	expect(t, a.Push(data(fileA, 7, "o\n")), "event[5:9] two")
}

func TestTextInitialTailMidLineDropsRestOfLine(t *testing.T) {
	a := newAssembler(Text, 100, newClock())
	a.Push(boundary(tail.InitialTail, fileA, 50, false))
	expect(t, a.Push(data(fileA, 50, "rest of old line\nnew\n")), "event[67:71] new")
}

func TestTextTooLargeEventIsRejectedWithoutBody(t *testing.T) {
	a := newAssembler(Text, 5, newClock())
	a.Push(boundary(tail.NewFileHead, fileA, 0, true))
	// 긴 줄이 여러 Chunk로 나뉘어 와도 거부 기록은 하나다
	expect(t, a.Push(data(fileA, 0, "1234")))
	expect(t, a.Push(data(fileA, 4, "5678")))
	expect(t, a.Push(data(fileA, 8, "9\nok\n")), "rejected[0:10] event_too_large", "event[10:13] ok")
}

func TestMultilineGroupsLinesUntilNextStart(t *testing.T) {
	clk := newClock()
	a := newAssembler(Multiline, 100, clk)
	a.Push(boundary(tail.NewFileHead, fileA, 0, true))
	expect(t, a.Push(data(fileA, 0, "2026-11-05 a\n  at x\n")))
	expect(t, a.Push(data(fileA, 20, "  at y\n2026-11-05 b\n")), "event[0:27] 2026-11-05 a\n  at x\n  at y")
	expect(t, a.Tick()) // 아직 MaxWait 전
	clk.add(5 * time.Second)
	expect(t, a.Tick(), "event[27:40] 2026-11-05 b")
}

func TestMultilineInitialTailWaitsForFirstStartLine(t *testing.T) {
	clk := newClock()
	a := newAssembler(Multiline, 100, clk)
	// 줄바꿈 바로 뒤에서 시작했어도 다음 줄이 앞 이벤트의 이어진 줄일 수 있다(D02)
	a.Push(boundary(tail.InitialTail, fileA, 100, true))
	expect(t, a.Push(data(fileA, 100, "  at old\n  at old2\n2026-11-05 new\n")))
	clk.add(5 * time.Second)
	expect(t, a.Tick(), "event[119:134] 2026-11-05 new")
}

func TestMultilineTooLargeEventIsRejected(t *testing.T) {
	clk := newClock()
	a := newAssembler(Multiline, 20, clk)
	a.Push(boundary(tail.NewFileHead, fileA, 0, true))
	got := a.Push(data(fileA, 0, "2026-11-05 a\n  at 1\n  at 2\n  at 3\n2026-11-05 b\n"))
	expect(t, got, "rejected[0:34] event_too_large")
	clk.add(5 * time.Second)
	expect(t, a.Tick(), "event[34:47] 2026-11-05 b")
}

func TestMultilineOverlongStartLineIsStillRecognized(t *testing.T) {
	clk := newClock()
	a := newAssembler(Multiline, 20, clk)
	a.Push(boundary(tail.NewFileHead, fileA, 0, true))
	long := "2026-11-05 " + strings.Repeat("x", 40) + "\n"
	got := a.Push(data(fileA, 0, "2026-11-05 a\n"+long+"2026-11-05 c\n"))
	expect(t, got, "event[0:13] 2026-11-05 a", "rejected[13:65] event_too_large")
}

func TestFileChangeEndsEventWithoutMixingFiles(t *testing.T) {
	a := newAssembler(Multiline, 100, newClock())
	a.Push(boundary(tail.NewFileHead, fileA, 0, true))
	expect(t, a.Push(data(fileA, 0, "2026-11-05 a\n  at x\n")))
	got := a.Push(tail.Chunk{File: fileB, Offset: 0, Boundary: tail.Rotated, PrevFile: fileA, OrderConfirmed: true})
	expect(t, got, "event[0:20] 2026-11-05 a\n  at x", "boundary rotated")
	// 새 파일의 첫 줄이 앞 이벤트의 뒷부분이어도 앞 파일 이벤트에 붙이지 않는다
	got = a.Push(data(fileB, 0, "  at y\n2026-11-05 b\n"))
	expect(t, got, "event[0:7]   at y")
	if got[0].File != fileB {
		t.Fatalf("event file %v, want %v", got[0].File, fileB)
	}
}

func TestPartialLineIsFlushedWhenFileEnds(t *testing.T) {
	a := newAssembler(Text, 100, newClock())
	a.Push(boundary(tail.NewFileHead, fileA, 0, true))
	expect(t, a.Push(data(fileA, 0, "last line without newline")))
	got := a.Push(tail.Chunk{File: fileA, Offset: 25, Boundary: tail.GoneBeforeRead, SkippedBytes: tail.Unknown})
	expect(t, got, "event[0:25] last line without newline", "boundary gone_before_read")
}

func TestCheckpointRebuildsUnfinishedEventAfterRestart(t *testing.T) {
	clk := newClock()
	a := newAssembler(Multiline, 100, clk)
	a.Push(boundary(tail.NewFileHead, fileA, 0, true))
	a.Push(data(fileA, 0, "2026-11-05 a\n  at x\n2026-11-05 b\n  at"))
	cp := a.Checkpoint()
	if cp.File != fileA || cp.Offset != 20 {
		t.Fatalf("checkpoint %+v, want the start of the unfinished event (20)", cp)
	}

	// 재시작: 같은 위치부터 다시 읽으면 끝나지 않았던 이벤트를 처음부터 다시 만든다
	b := newAssembler(Multiline, 100, clk)
	b.Restore(cp)
	expect(t, b.Push(data(fileA, 20, "2026-11-05 b\n  at y\n2026-11-05 c\n")), "event[20:40] 2026-11-05 b\n  at y")
}

func TestCheckpointKeepsInitialSkipState(t *testing.T) {
	a := newAssembler(Text, 100, newClock())
	a.Push(boundary(tail.InitialTail, fileA, 50, false))
	a.Push(data(fileA, 50, "rest of old"))
	cp := a.Checkpoint()
	if !cp.SkipToLine || cp.Offset != 50 {
		t.Fatalf("checkpoint %+v, want to keep skipping the old line from 50", cp)
	}
	b := newAssembler(Text, 100, newClock())
	b.Restore(cp)
	expect(t, b.Push(data(fileA, 50, "rest of old line\nnew\n")), "event[67:71] new")
}
