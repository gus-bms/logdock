// Package record는 대기에 저장하는 기록 형식과 수신 서버로 보내는 형식(계약 초안 2.3절)을 정한다.
package record

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/gus-bms/logdock/agent/internal/assemble"
	"github.com/gus-bms/logdock/agent/internal/tail"
)

// FlagEncodingError는 본문에 잘못된 UTF-8이 있어 원래 바이트를 base64로 보냈다는 표시다(Q02-04).
const FlagEncodingError = "encoding_error"

// Stream은 기록이 나온 흐름과 그 안의 위치다.
type Stream struct {
	Type   string `json:"type"`
	FileID string `json:"file_id"`
	Path   string `json:"path,omitempty"`
	Offset int64  `json:"offset"`
	Length int64  `json:"length,omitempty"`
}

// BoundaryInfo는 경계 기록의 내용이다. 잃은 바이트를 모르면 SkippedUnknown을 켜고
// SkippedBytes는 비운다. 모르는 값을 0으로 보내지 않기 위해서다.
type BoundaryInfo struct {
	Kind           string `json:"kind"`
	PrevFileID     string `json:"prev_file_id,omitempty"`
	OrderConfirmed bool   `json:"order_confirmed,omitempty"`
	AtLineStart    *bool  `json:"at_line_start,omitempty"`
	SkippedBytes   *int64 `json:"skipped_bytes,omitempty"`
	SkippedUnknown bool   `json:"skipped_unknown,omitempty"`
}

// Wire는 수신 서버로 보내는 기록이다.
type Wire struct {
	Seq        uint64        `json:"seq"`
	Kind       string        `json:"kind"`
	ObservedAt time.Time     `json:"observed_at"`
	Stream     Stream        `json:"stream"`
	Body       *string       `json:"body,omitempty"` // 빈 줄도 이벤트이므로 빈 문자열을 보낼 수 있게 포인터다
	BodyBase64 string        `json:"body_base64,omitempty"`
	Flags      []string      `json:"flags,omitempty"`
	Reason     string        `json:"reason,omitempty"`
	LimitBytes int           `json:"limit_bytes,omitempty"`
	Boundary   *BoundaryInfo `json:"boundary,omitempty"`
}

// Checkpoint는 이 기록 다음부터 읽으면 되는 위치다. 대기에만 두고 보내지 않는다.
type Checkpoint struct {
	Dev        uint64 `json:"dev"`
	Ino        uint64 `json:"ino"`
	Offset     int64  `json:"offset"`
	SkipToLine bool   `json:"skip_to_line,omitempty"`
	WaitStart  bool   `json:"wait_start,omitempty"`
	HeadLen    int    `json:"head_len,omitempty"`
	HeadSum    string `json:"head_sum,omitempty"`
	Gone       bool   `json:"gone,omitempty"`
}

// Stored는 대기에 저장하는 기록이다. 순번은 대기가 붙이므로 저장할 때 Seq는 0이다.
type Stored struct {
	Wire
	ConfigVersion int        `json:"config_version"`
	Checkpoint    Checkpoint `json:"checkpoint"`
}

// HeadFunc는 파일 앞부분의 길이와 해시를 알려 준다(tail.Follower.Head).
type HeadFunc func(tail.FileID) (int, [sha256.Size]byte, bool)

// Encode는 조립한 기록을 대기에 저장할 바이트로 바꾼다.
func Encode(r assemble.Record, path string, configVersion int, head HeadFunc) ([]byte, error) {
	s := Stored{
		Wire: Wire{
			Kind:       string(r.Kind),
			ObservedAt: r.ObservedAt.UTC().Truncate(time.Microsecond),
			Stream:     Stream{Type: "file", FileID: r.File.String(), Path: path, Offset: r.Offset, Length: r.End - r.Offset},
		},
		ConfigVersion: configVersion,
		Checkpoint: Checkpoint{
			Dev: r.After.File.Dev, Ino: r.After.File.Ino, Offset: r.After.Offset,
			SkipToLine: r.After.SkipToLine, WaitStart: r.After.WaitStart,
		},
	}
	if n, sum, ok := head(r.After.File); ok {
		s.Checkpoint.HeadLen, s.Checkpoint.HeadSum = n, hex.EncodeToString(sum[:])
	}
	switch r.Kind {
	case assemble.Event:
		if utf8.Valid(r.Body) {
			body := string(r.Body)
			s.Body = &body
		} else {
			s.BodyBase64 = base64.StdEncoding.EncodeToString(r.Body)
			s.Flags = []string{FlagEncodingError}
		}
	case assemble.Rejected:
		s.Reason, s.LimitBytes = r.Reason, r.LimitBytes
	case assemble.Boundary:
		s.Boundary = boundaryInfo(r.Chunk)
		s.Checkpoint.Gone = r.Chunk.Boundary == tail.GoneBeforeRead
	default:
		return nil, fmt.Errorf("record: unknown kind %q", r.Kind)
	}
	return json.Marshal(s)
}

func boundaryInfo(c tail.Chunk) *BoundaryInfo {
	b := &BoundaryInfo{Kind: string(c.Boundary)}
	switch c.Boundary {
	case tail.InitialTail:
		at := c.AtLineStart
		b.AtLineStart = &at
	case tail.Rotated:
		b.PrevFileID, b.OrderConfirmed = c.PrevFile.String(), c.OrderConfirmed
	case tail.GoneBeforeRead, tail.Truncated, tail.IdentityReused:
		if c.SkippedBytes == tail.Unknown {
			b.SkippedUnknown = true
		} else {
			n := c.SkippedBytes
			b.SkippedBytes = &n
		}
	}
	return b
}

// Decode는 대기에서 읽은 바이트를 기록으로 되돌린다.
func Decode(payload []byte) (Stored, error) {
	var s Stored
	if err := json.Unmarshal(payload, &s); err != nil {
		return Stored{}, fmt.Errorf("record: %w", err)
	}
	return s, nil
}

// Position은 저장한 재시작 위치를 tail과 assemble이 받는 값으로 바꾼다.
func (c Checkpoint) Position() (tail.Position, assemble.Checkpoint, error) {
	id := tail.FileID{Dev: c.Dev, Ino: c.Ino}
	p := tail.Position{File: id, Offset: c.Offset, HeadLen: c.HeadLen, Gone: c.Gone}
	if c.HeadSum != "" {
		b, err := hex.DecodeString(c.HeadSum)
		if err != nil || len(b) != sha256.Size {
			return tail.Position{}, assemble.Checkpoint{}, fmt.Errorf("record: bad head sum")
		}
		copy(p.HeadSum[:], b)
	}
	return p, assemble.Checkpoint{File: id, Offset: c.Offset, SkipToLine: c.SkipToLine, WaitStart: c.WaitStart}, nil
}
