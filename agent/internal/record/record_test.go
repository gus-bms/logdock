package record

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/gus-bms/logdock/agent/internal/assemble"
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
