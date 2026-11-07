// Package assemble은 tail이 읽은 바이트를 이벤트 기록으로 묶는다.
//
// 에이전트는 이벤트의 경계와 크기만 판단하고 시각·레벨·필드 해석은 수신 서버가 한다(D17-03).
// 그래서 JSON 형식도 여기서는 한 줄을 이벤트 하나로 볼 뿐 내용을 해석하지 않는다.
package assemble

import (
	"bytes"
	"regexp"
	"time"

	"github.com/gus-bms/logdock/agent/internal/tail"
)

// Format은 계약 초안 2.8절의 형식 종류다.
type Format string

const (
	Text      Format = "text"      // 한 줄이 이벤트 하나
	JSON      Format = "json"      // 한 줄이 이벤트 하나. 해석은 수신 서버가 한다
	Multiline Format = "multiline" // 시작 규칙에 맞는 줄부터 다음 시작 줄 전까지가 이벤트 하나
)

// Kind는 계약의 기록 종류다.
type Kind string

const (
	Event    Kind = "event"
	Rejected Kind = "rejected"
	Boundary Kind = "boundary"
)

// ReasonTooLarge는 크기 상한을 넘어 거부한 이벤트의 사유 코드다(계약 2.3, D03).
const ReasonTooLarge = "event_too_large"

// patternWindow는 상한을 넘은 긴 줄에서 시작 규칙을 맞춰 보려고 남겨 두는 앞부분 크기다.
const patternWindow = 4 << 10

// Record는 대기에 넣을 기록 하나다. 이벤트·거부·경계 모두 순번 하나를 차지한다.
type Record struct {
	Kind       Kind
	File       tail.FileID
	Offset     int64     // 이벤트 첫 바이트 위치. 경계면 경계 위치
	End        int64     // 이벤트 끝 바로 다음 위치
	ObservedAt time.Time // 첫 바이트를 읽은 시각
	Body       []byte    // Event만. 마지막 줄바꿈은 빼고 줄 사이 줄바꿈은 둔다
	Reason     string    // Rejected만
	LimitBytes int       // Rejected: 적용한 상한
	Chunk      tail.Chunk
	// After는 이 기록 바로 다음부터 읽으면 되는 위치다. 기록과 함께 대기에 저장해 두면,
	// 묶음을 쓰다 멈춰 뒤 기록이 깨져도 마지막으로 온전히 저장된 기록의 위치에서 이어 읽어
	// 앞 기록을 두 번 만들지 않는다(D06, AG-12).
	After Checkpoint
}

// Options의 기본값은 시제품용이다. 제품 수치는 측정 뒤 정한다.
type Options struct {
	Format        Format
	StartPattern  *regexp.Regexp // Multiline에서 새 이벤트의 첫 줄
	MaxEventBytes int            // D03 상한. 넘으면 본문 없이 거부한다
	// MaxWait는 여러 줄 이벤트를 다음 시작 줄 없이 끝내는 시간이다. 마지막 오류의 stack
	// trace처럼 뒤에 줄이 더 오지 않는 이벤트를 무한히 붙잡지 않는다(AG-09).
	MaxWait time.Duration
	Now     func() time.Time
}

func (o *Options) setDefaults() {
	if o.MaxEventBytes <= 0 {
		o.MaxEventBytes = 1 << 20
	}
	if o.MaxWait <= 0 {
		o.MaxWait = 5 * time.Second
	}
	if o.Now == nil {
		o.Now = time.Now
	}
}

// Checkpoint는 재시작 뒤 같은 기록을 다시 만들 수 있는 위치다. 아직 기록으로 내지 않은
// 바이트의 시작이며, 시작 경계에서 버리던 중이었는지도 함께 둔다.
type Checkpoint struct {
	File       tail.FileID
	Offset     int64
	SkipToLine bool // D02: 쓰던 줄의 나머지를 버리는 중
	WaitStart  bool // D02 여러 줄: 첫 시작 줄이 올 때까지 버리는 중
}

// line은 아직 줄바꿈이 오지 않은 줄이다.
type line struct {
	active bool
	start  int64
	raw    []byte // 상한 이하일 때만 모은다
	head   []byte // 상한을 넘으면 시작 규칙 판정용 앞부분만 남긴다
	over   bool
	seenAt time.Time
}

// event는 조립 중인 이벤트다.
type event struct {
	open     bool
	start    int64
	buf      []byte
	tooLarge bool
	seenAt   time.Time
}

// Assembler는 파일 하나씩 차례로 들어오는 Chunk를 기록으로 묶는다. 한 고루틴에서만 쓴다.
type Assembler struct {
	opt Options

	file       tail.FileID
	pos        int64 // 다음 바이트의 파일 위치
	skipToLine bool
	waitStart  bool
	ln         line
	ev         event
	lastData   time.Time
}

// New는 Assembler를 만든다. Multiline이면 StartPattern이 있어야 한다(설정 검사에서 막는다).
func New(opt Options) *Assembler {
	opt.setDefaults()
	return &Assembler{opt: opt}
}

// Restore는 Checkpoint의 버리는 상태를 되살린다. tail.Follower도 같은 위치로 되돌려야 한다.
func (a *Assembler) Restore(cp Checkpoint) {
	a.file, a.pos = cp.File, cp.Offset
	a.skipToLine, a.waitStart = cp.SkipToLine, cp.WaitStart
}

// Checkpoint는 지금까지 낸 기록 다음 위치다. 기록을 대기에 확정한 뒤 이 값을 읽기 위치로
// 저장하면, 재시작 뒤 조립 중이던 이벤트를 처음부터 다시 만든다(AG-12).
func (a *Assembler) Checkpoint() Checkpoint {
	off := a.pos
	switch {
	case a.ev.open:
		off = a.ev.start
	case a.ln.active:
		off = a.ln.start
	}
	return Checkpoint{File: a.file, Offset: off, SkipToLine: a.skipToLine, WaitStart: a.waitStart}
}

// Push는 Chunk 하나를 받아 끝난 기록을 돌려준다.
func (a *Assembler) Push(c tail.Chunk) []Record {
	now := a.opt.Now()
	var out []Record
	if c.Boundary != "" {
		// 파일이 바뀌거나 끊겼다. 조립 중인 이벤트는 여기서 끝낸다(파일 사이를 섞지 않는다, AG-08).
		out = a.flush(out)
		a.file, a.pos = c.File, c.Offset
		a.skipToLine, a.waitStart = false, false
		if c.Boundary == tail.InitialTail || c.Boundary == tail.NewFileTail {
			// D02: 파일 끝에서 시작하면 그때 쓰던 줄의 나머지는 버리고, 여러 줄이면 첫 시작 줄을
			// 기다린다. 최초 연결과 언제 생겼는지 모르는 파일이 그렇다.
			a.skipToLine = !c.AtLineStart
			a.waitStart = a.opt.Format == Multiline
		}
		after := Checkpoint{File: c.File, Offset: c.Offset, SkipToLine: a.skipToLine, WaitStart: a.waitStart}
		return append(out, Record{Kind: Boundary, File: c.File, Offset: c.Offset, End: c.Offset, ObservedAt: now, Chunk: c, After: after})
	}
	if c.File != a.file || c.Offset != a.pos {
		out = a.flush(out) // 경계 없이 파일이 바뀌면 안 되지만, 바뀌었다면 섞지 않는다
		a.file, a.pos = c.File, c.Offset
	}
	a.lastData = now
	data := c.Data
	for len(data) > 0 {
		i := bytes.IndexByte(data, '\n')
		part := data
		if i >= 0 {
			part = data[:i+1]
		}
		data = data[len(part):]
		a.addToLine(part, now)
		a.pos += int64(len(part))
		if i >= 0 {
			out = a.endLine(out)
		}
	}
	return out
}

// End는 파일을 다 읽었을 때 줄바꿈 없이 남은 줄과 조립 중인 이벤트를 끝낸다(tail.Chunk.End).
// 같은 파일의 바이트는 더 오지 않는다.
func (a *Assembler) End() []Record {
	return a.flush(nil)
}

// Tick은 여러 줄 이벤트가 MaxWait 동안 이어지지 않았으면 끝낸다. 주기적으로 부른다.
func (a *Assembler) Tick() []Record {
	if a.opt.Format != Multiline || !a.ev.open || a.ln.active {
		return nil
	}
	if a.opt.Now().Sub(a.lastData) < a.opt.MaxWait {
		return nil
	}
	return a.finish(nil, a.pos)
}

func (a *Assembler) addToLine(part []byte, now time.Time) {
	l := &a.ln
	if !l.active {
		*l = line{active: true, start: a.pos, seenAt: now}
	}
	if l.over {
		if room := patternWindow - len(l.head); room > 0 {
			l.head = append(l.head, part[:min(room, len(part))]...)
		}
		return
	}
	if len(l.raw)+len(part) > a.opt.MaxEventBytes+2 { // +2: 줄 끝 "\r\n"은 본문이 아니다
		l.over = true
		l.head = append(l.raw[:0:0], l.raw[:min(len(l.raw), patternWindow)]...)
		if room := patternWindow - len(l.head); room > 0 {
			l.head = append(l.head, part[:min(room, len(part))]...)
		}
		l.raw = nil
		return
	}
	l.raw = append(l.raw, part...)
}

// endLine은 줄 하나가 끝났을 때 형식에 따라 이벤트를 만든다.
func (a *Assembler) endLine(out []Record) []Record {
	l := a.ln
	a.ln = line{}
	if a.skipToLine { // D02: 연결 당시 쓰던 줄의 나머지
		a.skipToLine = false
		return out
	}
	if a.opt.Format != Multiline {
		a.ev = event{open: true, start: l.start, seenAt: l.seenAt}
		a.addLineToEvent(l)
		return a.finish(out, a.pos)
	}
	isStart := a.matchStart(l)
	if a.waitStart {
		if !isStart {
			return out // D02: 연결 전부터 쓰던 여러 줄 이벤트의 나머지
		}
		a.waitStart = false
	}
	if isStart && a.ev.open {
		out = a.finish(out, l.start)
	}
	if !a.ev.open {
		// 시작 줄이 아니어도 새 이벤트로 둔다. 회전으로 앞 파일과 나뉜 이벤트의 뒷부분을
		// 다른 파일의 이벤트에 붙이지 않기 위해서다(AG-08).
		a.ev = event{open: true, start: l.start, seenAt: l.seenAt}
	}
	a.addLineToEvent(l)
	return out
}

func (a *Assembler) matchStart(l line) bool {
	text := l.raw
	if l.over {
		text = l.head
	}
	return a.opt.StartPattern.Match(trimNewline(text))
}

func (a *Assembler) addLineToEvent(l line) {
	e := &a.ev
	if e.tooLarge {
		return
	}
	if l.over || len(e.buf)+len(l.raw) > a.opt.MaxEventBytes+2 {
		// D03: 상한을 넘으면 본문을 더 쌓지 않고 버린다. 끝을 만나면 거부 기록 하나만 낸다.
		e.tooLarge, e.buf = true, nil
		return
	}
	e.buf = append(e.buf, l.raw...)
}

// finish는 조립 중인 이벤트를 end 위치에서 끝낸다.
func (a *Assembler) finish(out []Record, end int64) []Record {
	e := a.ev
	a.ev = event{}
	if !e.open {
		return out
	}
	r := Record{File: a.file, Offset: e.start, End: end, ObservedAt: e.seenAt,
		After: Checkpoint{File: a.file, Offset: end, SkipToLine: a.skipToLine, WaitStart: a.waitStart}}
	body := trimNewline(e.buf)
	if e.tooLarge || len(body) > a.opt.MaxEventBytes {
		r.Kind, r.Reason, r.LimitBytes = Rejected, ReasonTooLarge, a.opt.MaxEventBytes
		return append(out, r)
	}
	r.Kind, r.Body = Event, bytes.Clone(body)
	return append(out, r)
}

// flush는 파일이 끝났을 때 줄바꿈 없이 남은 줄과 조립 중인 이벤트를 끝낸다.
func (a *Assembler) flush(out []Record) []Record {
	if a.ln.active {
		out = a.endLine(out)
	}
	return a.finish(out, a.pos)
}

// trimNewline은 줄 끝의 "\n" 또는 "\r\n"을 뗀다.
func trimNewline(b []byte) []byte {
	b = bytes.TrimSuffix(b, []byte("\n"))
	return bytes.TrimSuffix(b, []byte("\r"))
}
