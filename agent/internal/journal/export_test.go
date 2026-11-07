package journal

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestParserReadsTextAndBinaryFields(t *testing.T) {
	bad := string([]byte{'o', 'k', 0xff, 0xfe})
	var b bytes.Buffer
	for _, e := range []Entry{
		NewEntry("__CURSOR=s=1", "MESSAGE=plain text", "PRIORITY=6"),
		NewEntry("__CURSOR=s=2", "MESSAGE=two\nlines"),
		NewEntry("__CURSOR=s=3", "MESSAGE="+bad, "_PID=42"),
	} {
		if err := WriteExport(&b, e); err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Contains(b.Bytes(), []byte("MESSAGE\n")) {
		t.Fatal("expected a binary-encoded field in the fixture")
	}
	p := NewParser(&b, 0)
	want := []string{"plain text", "two\nlines", bad}
	for i, w := range want {
		e, err := p.Next()
		if err != nil {
			t.Fatalf("entry %d: %v", i, err)
		}
		if got := e.String(FieldMessage); got != w {
			t.Errorf("entry %d: MESSAGE %q, want %q", i, got, w)
		}
	}
	if v, ok := mustNext(t, NewParser(strings.NewReader("PRIORITY=3\n\n"), 0)).Int(FieldPriority); !ok || v != 3 {
		t.Errorf("PRIORITY = %d, %v", v, ok)
	}
	if _, err := p.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("after last entry: %v", err)
	}
}

func mustNext(t *testing.T, p *Parser) Entry {
	t.Helper()
	e, err := p.Next()
	if err != nil {
		t.Fatal(err)
	}
	return e
}

// 상한을 넘는 값은 앞부분만 남기되 원래 길이를 알고, 그 뒤 항목도 어긋나지 않고 읽는다.
func TestParserTruncatesLongValuesAndStaysAligned(t *testing.T) {
	long := strings.Repeat("x", 10_000)
	var b bytes.Buffer
	WriteExport(&b, NewEntry("MESSAGE="+long))
	WriteExport(&b, NewEntry("MESSAGE="+long+"\n"))
	WriteExport(&b, NewEntry("MESSAGE=after"))
	p := NewParser(&b, MinValue)
	for i := range 2 {
		e := mustNext(t, p)
		if len(e.Bytes(FieldMessage)) != MinValue || !e.Truncated(FieldMessage) {
			t.Errorf("entry %d: kept %d bytes, truncated %v", i, len(e.Bytes(FieldMessage)), e.Truncated(FieldMessage))
		}
		if e.Size(FieldMessage) != len(long)+i {
			t.Errorf("entry %d: size %d", i, e.Size(FieldMessage))
		}
	}
	if got := mustNext(t, p).String(FieldMessage); got != "after" {
		t.Errorf("next entry %q", got)
	}
}

// 끝나지 않은 항목은 내지 않는다. journalctl을 끝낼 때 출력이 항목 중간에서 끊길 수 있다.
func TestParserDropsUnfinishedEntry(t *testing.T) {
	for _, s := range []string{"MESSAGE=half", "MESSAGE=whole\n", "MESSAGE\n\x05\x00\x00\x00\x00\x00\x00\x00ab"} {
		if _, err := NewParser(strings.NewReader(s), 0).Next(); !errors.Is(err, io.ErrUnexpectedEOF) {
			t.Errorf("%q: %v", s, err)
		}
	}
	if _, err := NewParser(strings.NewReader("=x\n\n"), 0).Next(); !errors.Is(err, ErrFormat) {
		t.Errorf("empty field name: %v", err)
	}
}

// Ident는 값을 자르는 상한이 달라도 같다. 이벤트 크기 상한을 바꿔도 재시작 위치 확인이 맞아야 한다.
func TestIdentDoesNotDependOnValueLimit(t *testing.T) {
	long := strings.Repeat("y", 70_000)
	var b bytes.Buffer
	WriteExport(&b, NewEntry("_BOOT_ID=b", "__MONOTONIC_TIMESTAMP=5", "__REALTIME_TIMESTAMP=9", "MESSAGE="+long))
	raw := b.Bytes()
	small := mustNext(t, NewParser(bytes.NewReader(raw), MinValue))
	big := mustNext(t, NewParser(bytes.NewReader(raw), 1<<20))
	if small.Ident() != big.Ident() {
		t.Fatalf("ident differs: %s vs %s", small.Ident(), big.Ident())
	}
	other := NewEntry("_BOOT_ID=b", "__MONOTONIC_TIMESTAMP=5", "__REALTIME_TIMESTAMP=9", "MESSAGE=other")
	if other.Ident() == big.Ident() {
		t.Fatal("different content must give a different ident")
	}
	cursorOnly := NewEntry("__CURSOR=s=new", "_BOOT_ID=b", "__MONOTONIC_TIMESTAMP=5", "__REALTIME_TIMESTAMP=9", "MESSAGE=other")
	if cursorOnly.Ident() != other.Ident() {
		t.Fatal("the cursor string must not change the ident")
	}
}
