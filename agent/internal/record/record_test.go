package record

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/gus-bms/logdock/agent/internal/assemble"
	"github.com/gus-bms/logdock/agent/internal/journal"
	"github.com/gus-bms/logdock/agent/internal/tail"
)

var fid = tail.FileID{Dev: 1, Ino: 42}

func headFn(tail.FileID) (int, [sha256.Size]byte, bool) {
	return 4, sha256.Sum256([]byte("head")), true
}

func encode(t *testing.T, r assemble.Record) (Stored, string) {
	t.Helper()
	b, err := Encode(r, "/var/app/app.log", 3, headFn)
	if err != nil {
		t.Fatal(err)
	}
	s, err := Decode(b)
	if err != nil {
		t.Fatal(err)
	}
	return s, string(b)
}

func TestEventRoundTripKeepsRestartPosition(t *testing.T) {
	at := time.Date(2026, 11, 5, 1, 0, 0, 123456789, time.UTC)
	s, _ := encode(t, assemble.Record{
		Kind: assemble.Event, File: fid, Offset: 10, End: 20, ObservedAt: at, Body: []byte("hello"),
		After: assemble.Checkpoint{File: fid, Offset: 20},
	})
	if s.Kind != "event" || s.Body == nil || *s.Body != "hello" || s.Stream.Offset != 10 || s.Stream.Length != 10 {
		t.Fatalf("got %+v", s)
	}
	if !s.ObservedAt.Equal(at.Truncate(time.Microsecond)) || s.ConfigVersion != 3 {
		t.Fatalf("observed %v config %d", s.ObservedAt, s.ConfigVersion)
	}
	pos, cp, err := s.Checkpoint.Position()
	if err != nil {
		t.Fatal(err)
	}
	if pos.File != fid || pos.Offset != 20 || pos.HeadLen != 4 || pos.HeadSum != sha256.Sum256([]byte("head")) || cp.Offset != 20 {
		t.Fatalf("position %+v checkpoint %+v", pos, cp)
	}
}

func TestInvalidUTF8IsSentAsBase64WithFlag(t *testing.T) {
	raw := []byte{0xff, 'a'}
	s, _ := encode(t, assemble.Record{Kind: assemble.Event, File: fid, Body: raw})
	if s.Body != nil || s.BodyBase64 != base64.StdEncoding.EncodeToString(raw) || len(s.Flags) != 1 || s.Flags[0] != FlagEncodingError {
		t.Fatalf("got %+v", s)
	}
}

func TestEmptyLineIsStillAnEvent(t *testing.T) {
	_, js := encode(t, assemble.Record{Kind: assemble.Event, File: fid, Body: []byte{}})
	if !strings.Contains(js, `"body":""`) {
		t.Fatalf("json %s, want an empty body sent", js)
	}
}

func TestUnknownLossIsNotReportedAsZero(t *testing.T) {
	s, js := encode(t, assemble.Record{Kind: assemble.Boundary, File: fid,
		Chunk: tail.Chunk{File: fid, Boundary: tail.GoneBeforeRead, SkippedBytes: tail.Unknown}})
	if !s.Boundary.SkippedUnknown || s.Boundary.SkippedBytes != nil || strings.Contains(js, "skipped_bytes") {
		t.Fatalf("json %s, want skipped_unknown and no byte count", js)
	}
	if !s.Checkpoint.Gone {
		t.Fatal("a gone boundary must mark its restart position gone so it is not reported again")
	}
}

func TestKnownLossIsReported(t *testing.T) {
	s, _ := encode(t, assemble.Record{Kind: assemble.Boundary, File: fid,
		Chunk: tail.Chunk{File: fid, Boundary: tail.GoneBeforeRead, SkippedBytes: 12}})
	if s.Boundary.SkippedUnknown || s.Boundary.SkippedBytes == nil || *s.Boundary.SkippedBytes != 12 {
		t.Fatalf("got %+v", s.Boundary)
	}
}

func TestWireDoesNotCarryLocalFields(t *testing.T) {
	s, _ := encode(t, assemble.Record{Kind: assemble.Event, File: fid, Body: []byte("x"),
		After: assemble.Checkpoint{File: fid, Offset: 5}})
	b, err := json.Marshal(s.Wire)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "checkpoint") || strings.Contains(string(b), "config_version") {
		t.Fatalf("wire %s must not carry the local restart position", b)
	}
}

// 파일 위치 0도 보낸다. journald 칸을 더하며 omitempty가 붙었어도 파일 흐름에서는 빠지면 안 된다.
func TestFileStreamKeepsOffsetZero(t *testing.T) {
	s, _ := encode(t, assemble.Record{Kind: assemble.Event, File: fid, Offset: 0, End: 1, Body: []byte("x")})
	b, err := json.Marshal(s.Wire)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"offset":0`) || strings.Contains(string(b), "cursor") {
		t.Fatalf("wire %s", b)
	}
}

func TestJournalRecordRoundTrip(t *testing.T) {
	prio := 3
	after := journal.Position{Cursor: "s=a;i=9", Ident: "b/9/1/ff", Skip: []string{"b/8/1/aa"}, DropKeys: []string{"p:x"}, WaitStart: true}
	b, err := EncodeJournal(journal.Record{Kind: assemble.Event, Body: []byte("boom"),
		Meta:  journal.Meta{Cursor: "s=a;i=7", RealtimeUS: 1_762_400_000_000_001, SourceRealtimeUS: 1_762_400_000_000_000, Priority: prio, ContainerID: "cid"},
		After: after}, 4)
	if err != nil {
		t.Fatal(err)
	}
	s, err := Decode(b)
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Checkpoint.JournalPosition(); got.Cursor != after.Cursor || got.Ident != after.Ident ||
		len(got.Skip) != 1 || len(got.DropKeys) != 1 || !got.WaitStart {
		t.Fatalf("position %+v", got)
	}
	w, err := json.Marshal(s.Wire)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"type":"journald"`, `"cursor":"s=a;i=7"`, `"realtime_us":1762400000000001`,
		`"source_realtime_us":1762400000000000`, `"priority":3`, `"container_id":"cid"`} {
		if !strings.Contains(string(w), want) {
			t.Errorf("wire %s lacks %s", w, want)
		}
	}
	if strings.Contains(string(w), "file_id") || strings.Contains(string(w), "offset") {
		t.Fatalf("journald stream must not carry file fields: %s", w)
	}
}

// 컨테이너 대상의 속도 제한 경계는 Docker 데몬 unit 전체의 수라 이 대상의 몫은 모른다.
func TestJournalDropBoundary(t *testing.T) {
	for _, tc := range []struct {
		share   bool
		n       int64
		unknown bool
	}{{false, 120, false}, {true, 120, true}, {false, -1, true}} {
		b, err := EncodeJournal(journal.Record{Kind: assemble.Boundary, Meta: journal.Meta{Priority: -1},
			Boundary: journal.BoundaryInfo{Kind: journal.BoundarySourceDropped, Unit: "order.service", Dropped: tc.n, ShareUnknown: tc.share}}, 1)
		if err != nil {
			t.Fatal(err)
		}
		s, _ := Decode(b)
		if s.Boundary.SkippedUnknown != tc.unknown || s.Boundary.Unit != "order.service" ||
			(tc.n >= 0) != (s.Boundary.DroppedEntries != nil) {
			t.Fatalf("%+v: got %+v", tc, s.Boundary)
		}
		if s.Stream.Priority != nil {
			t.Fatal("unknown priority must not be sent")
		}
	}
}
