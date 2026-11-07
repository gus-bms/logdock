// Package journal은 journald 입력을 읽는다(수집 명세 journald 입력 Q02-02).
//
// journalctl을 하위 프로세스로 띄워 export 형식으로 읽는다. systemd 라이브러리를 붙이면 cgo가
// 필요해 이 PC(macOS)에서 Linux용으로 바로 빌드할 수 없고, journal 파일을 직접 읽으면 내부 파일
// 형식을 따라가야 한다. export 형식은 systemd가 백업·전송용으로 공개한 직렬화 형식이다.
//
// 흐름: Parser가 항목(Entry)을 읽고, Pipeline이 나뉜 메시지 조각을 한 줄로 이은 뒤 형식에 따라
// 이벤트 기록(Record)으로 묶는다. 기록마다 재시작 위치(Position)를 함께 내므로, 대기에 확정된
// 마지막 기록의 위치에서 다시 시작하면 중복도 유실도 없다(D06, AG-12).
package journal

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// 필드 이름. 뜻은 systemd.journal-fields(7)와 Docker journald 드라이버를 따른다.
const (
	FieldCursor          = "__CURSOR"
	FieldRealtime        = "__REALTIME_TIMESTAMP"
	FieldMonotonic       = "__MONOTONIC_TIMESTAMP"
	FieldBootID          = "_BOOT_ID"
	FieldSourceRealtime  = "_SOURCE_REALTIME_TIMESTAMP"
	FieldMessage         = "MESSAGE"
	FieldMessageID       = "MESSAGE_ID"
	FieldPriority        = "PRIORITY"
	FieldSystemdUnit     = "_SYSTEMD_UNIT"
	FieldStreamID        = "_STREAM_ID"
	FieldLineBreak       = "_LINE_BREAK"
	FieldObjectUnit      = "OBJECT_SYSTEMD_UNIT"
	FieldNDropped        = "N_DROPPED"
	FieldContainerName   = "CONTAINER_NAME"
	FieldContainerIDFull = "CONTAINER_ID_FULL"
	FieldPartialMessage  = "CONTAINER_PARTIAL_MESSAGE"
	FieldPartialID       = "CONTAINER_PARTIAL_ID"
	FieldPartialOrdinal  = "CONTAINER_PARTIAL_ORDINAL"
	FieldPartialLast     = "CONTAINER_PARTIAL_LAST"
)

// MessageIDDropped는 journald가 속도 제한으로 메시지를 버린 뒤 남기는 알림의 MESSAGE_ID다
// (systemd sd-messages.h의 SD_MESSAGE_JOURNAL_DROPPED). 버린 수는 N_DROPPED에 있다.
const MessageIDDropped = "a596d6fe7bfa4994828e72309e95d61e"

const (
	maxName = 256 // 필드 이름을 이보다 길게 읽지 않는다. 형식이 깨진 출력에서 메모리를 지킨다
	// MinValue는 필드 값 상한의 최솟값이다. Ident가 앞 256바이트를 쓰므로 그보다 커야 한다.
	MinValue = 4 << 10
	maxSize  = 1 << 40 // 바이너리 필드 크기가 이보다 크면 형식이 깨진 것으로 본다
)

// ErrFormat은 export 형식이 아닌 출력을 받았다는 뜻이다.
var ErrFormat = errors.New("journal: bad export format")

// value는 필드 값의 앞부분과 원래 길이다. 상한을 넘은 값은 앞부분만 둔다.
type value struct {
	data []byte
	size int
}

// Entry는 journal 항목 하나다. 같은 필드가 여러 번 오면 첫 값만 둔다. systemd 문서는 MESSAGE를
// 여러 번 넣지 말라고 하고, 여러 값을 쓰는 필드는 이 에이전트가 읽지 않는다.
type Entry struct {
	fields map[string]value
}

// NewEntry는 시험과 가짜 journal이 쓰는 항목을 만든다. 인자는 "이름=값"이다.
func NewEntry(fields ...string) Entry {
	e := Entry{fields: map[string]value{}}
	for _, f := range fields {
		name, v, _ := strings.Cut(f, "=")
		e.add(name, value{data: []byte(v), size: len(v)})
	}
	return e
}

func (e *Entry) add(name string, v value) {
	if _, ok := e.fields[name]; !ok {
		e.fields[name] = v
	}
}

// Has는 필드가 있는지 본다.
func (e Entry) Has(name string) bool {
	_, ok := e.fields[name]
	return ok
}

// Bytes는 필드 값이다. 상한을 넘었으면 앞부분이다.
func (e Entry) Bytes(name string) []byte { return e.fields[name].data }

// String은 필드 값을 문자열로 돌려준다.
func (e Entry) String(name string) string { return string(e.fields[name].data) }

// Truncated는 필드 값이 상한을 넘어 앞부분만 남았는지 본다.
func (e Entry) Truncated(name string) bool {
	v, ok := e.fields[name]
	return ok && v.size > len(v.data)
}

// Int는 십진수 필드 값이다.
func (e Entry) Int(name string) (int64, bool) {
	v, ok := e.fields[name]
	if !ok {
		return 0, false
	}
	n, err := strconv.ParseInt(string(v.data), 10, 64)
	return n, err == nil
}

// Size는 필드 값의 원래 길이다.
func (e Entry) Size(name string) int { return e.fields[name].size }

// Fields는 필드 이름을 정렬해 돌려준다. 가짜 journal이 쓴다.
func (e Entry) Fields() []string {
	names := make([]string, 0, len(e.fields))
	for n := range e.fields {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// Ident는 항목을 알아보는 값이다. systemd 문서는 같은 항목을 여러 커서 문자열이 가리킬 수 있어
// 커서를 문자열로 비교할 수 없다고 한다(sd_journal_get_cursor(3)). 그래서 커서 대신 부팅 ID,
// 단조 시각, 벽시계 시각과 필드 내용의 요약으로 같은 항목인지 본다. 요약은 필드마다 이름·원래
// 길이·앞 256바이트만 쓴다. 이벤트 크기 상한 설정이 바뀌어 값을 자르는 길이가 달라져도 같은
// 항목이 같은 값이 되게 하려는 것이다.
func (e Entry) Ident() string {
	names := make([]string, 0, len(e.fields))
	for n := range e.fields {
		if !strings.HasPrefix(n, "__") {
			names = append(names, n)
		}
	}
	sort.Strings(names)
	h := fnv.New64a()
	var size [8]byte
	for _, n := range names {
		v := e.fields[n]
		h.Write([]byte(n))
		binary.LittleEndian.PutUint64(size[:], uint64(v.size))
		h.Write(size[:])
		h.Write(v.data[:min(len(v.data), 256)])
	}
	return e.String(FieldBootID) + "/" + e.String(FieldMonotonic) + "/" + e.String(FieldRealtime) + "/" +
		strconv.FormatUint(h.Sum64(), 16)
}

// Parser는 journalctl --output=export 출력을 항목으로 읽는다.
//
// 형식(systemd JOURNAL_EXPORT_FORMATS): 출력 가능한 UTF-8 값은 "이름=값\n"이고, 그 밖의 값은
// "이름\n" 뒤에 64비트 little endian 길이, 값, "\n"이다. 항목 사이는 빈 줄이다.
type Parser struct {
	r        *bufio.Reader
	maxValue int
}

// NewParser는 Parser를 만든다. maxValue를 넘는 필드 값은 앞부분만 둔다.
func NewParser(r io.Reader, maxValue int) *Parser {
	return &Parser{r: bufio.NewReaderSize(r, 64<<10), maxValue: max(maxValue, MinValue)}
}

// Next는 다음 항목을 돌려준다. 출력이 항목 사이에서 끝나면 io.EOF, 항목 중간에 끝나면
// io.ErrUnexpectedEOF다. 끝나지 않은 항목은 내지 않는다.
func (p *Parser) Next() (Entry, error) {
	e := Entry{fields: map[string]value{}}
	for {
		line, size, err := p.readLine(p.maxValue + maxName + 1)
		if err != nil {
			if errors.Is(err, io.EOF) && len(e.fields) == 0 {
				return Entry{}, io.EOF
			}
			if errors.Is(err, io.EOF) {
				return Entry{}, io.ErrUnexpectedEOF
			}
			return Entry{}, err
		}
		if size == 0 {
			if len(e.fields) == 0 {
				continue
			}
			return e, nil
		}
		if i := bytes.IndexByte(line, '='); i >= 0 {
			if i == 0 || i > maxName {
				return Entry{}, ErrFormat
			}
			data := line[i+1:]
			e.add(string(line[:i]), value{data: bytes.Clone(data[:min(len(data), p.maxValue)]), size: size - i - 1})
			continue
		}
		if size > maxName {
			return Entry{}, ErrFormat
		}
		v, err := p.readBinary()
		if err != nil {
			return Entry{}, err
		}
		e.add(string(line), v)
	}
}

// readLine은 줄바꿈까지 읽어 앞 limit 바이트와 원래 길이를 돌려준다.
func (p *Parser) readLine(limit int) ([]byte, int, error) {
	var buf []byte
	size := 0
	for {
		chunk, err := p.r.ReadSlice('\n')
		data := chunk
		if err == nil {
			data = data[:len(data)-1]
		}
		if room := limit - len(buf); room > 0 && len(data) > 0 {
			buf = append(buf, data[:min(room, len(data))]...)
		}
		size += len(data)
		switch {
		case err == nil:
			return buf, size, nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		case errors.Is(err, io.EOF):
			if size == 0 {
				return nil, 0, io.EOF
			}
			return nil, 0, io.ErrUnexpectedEOF
		default:
			return nil, 0, err
		}
	}
}

func (p *Parser) readBinary() (value, error) {
	var sz [8]byte
	if _, err := io.ReadFull(p.r, sz[:]); err != nil {
		return value{}, unexpected(err)
	}
	n := binary.LittleEndian.Uint64(sz[:])
	if n > maxSize {
		return value{}, fmt.Errorf("%w: field size %d", ErrFormat, n)
	}
	keep := min(int(n), p.maxValue)
	data := make([]byte, keep)
	if _, err := io.ReadFull(p.r, data); err != nil {
		return value{}, unexpected(err)
	}
	if _, err := io.CopyN(io.Discard, p.r, int64(n)-int64(keep)); err != nil {
		return value{}, unexpected(err)
	}
	b, err := p.r.ReadByte()
	if err != nil {
		return value{}, unexpected(err)
	}
	if b != '\n' {
		return value{}, ErrFormat
	}
	return value{data: data, size: int(n)}, nil
}

func unexpected(err error) error {
	if errors.Is(err, io.EOF) {
		return io.ErrUnexpectedEOF
	}
	return err
}

// WriteExport는 항목을 export 형식으로 쓴다. 가짜 journal과 시험이 쓴다. 줄바꿈이나 제어 문자,
// 잘못된 UTF-8이 든 값은 바이너리 형식으로 쓴다.
func WriteExport(w io.Writer, e Entry) error {
	var b bytes.Buffer
	for _, n := range e.Fields() {
		v := e.fields[n].data
		if textSafe(v) {
			b.WriteString(n)
			b.WriteByte('=')
			b.Write(v)
			b.WriteByte('\n')
			continue
		}
		b.WriteString(n)
		b.WriteByte('\n')
		var sz [8]byte
		binary.LittleEndian.PutUint64(sz[:], uint64(len(v)))
		b.Write(sz[:])
		b.Write(v)
		b.WriteByte('\n')
	}
	b.WriteByte('\n')
	_, err := w.Write(b.Bytes())
	return err
}

// textSafe는 값을 "이름=값" 줄로 쓸 수 있는지 본다. 형식 문서의 "제어 문자가 아닌 UTF-8"
// 정의(TAB과 32 이상, 127과 128~159 제외)를 따른다.
func textSafe(v []byte) bool {
	if !utf8.Valid(v) {
		return false
	}
	for _, r := range string(v) {
		if (r < 32 && r != '\t') || r == 127 || (r >= 128 && r <= 159) {
			return false
		}
	}
	return true
}
