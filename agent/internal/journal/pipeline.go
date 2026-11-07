package journal

import (
	"bytes"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gus-bms/logdock/agent/internal/assemble"
)

// 경계 종류(계약 2.3절).
const (
	// BoundaryInitialTail은 최초 연결의 시작 경계다. 그때 journal의 마지막 항목 뒤부터 읽는다(D02).
	BoundaryInitialTail = "initial_tail"
	// BoundarySourceDropped는 journald가 속도 제한으로 버린 메시지가 있다는 경계다.
	BoundarySourceDropped = "source_dropped"
)

// FlagIncomplete는 나뉜 메시지의 마지막 조각을 기다리다 시간이 지나 받은 조각만 낸 이벤트,
// 또는 앞 조각 없이 뒷조각만 받은 이벤트의 표시다.
const FlagIncomplete = "incomplete"

// patternWindow는 상한을 넘은 줄에서 시작 규칙을 맞춰 보려고 남기는 앞부분 크기다(assemble과 같다).
const patternWindow = 4 << 10

// Target은 수집 대상이다(계약 2.8절 journald).
type Target struct {
	Kind string // container | unit
	Name string // 컨테이너 이름이나 unit 이름(접미사 포함)
}

// Options의 기본값은 시제품용이다. 제품 수치는 측정 뒤 정한다.
type Options struct {
	Target        Target
	Format        assemble.Format
	StartPattern  *regexp.Regexp // Multiline에서 새 이벤트의 첫 줄
	MaxEventBytes int            // D03 상한. 넘으면 본문 없이 거부한다
	// MaxWait는 여러 줄 이벤트를 다음 시작 줄 없이 끝내는 시간이자, 나뉜 메시지의 다음 조각을
	// 기다리는 시간이다. Docker는 줄바꿈 없이 끝난 출력을 마지막 조각 표시 없이 보낸다.
	MaxWait time.Duration
	// MaxSkip은 재시작 위치 뒤에서 이미 처리한 항목을 기억하는 수의 상한이다. 넘으면 재시작 위치를
	// 붙잡고 있는 줄이나 이벤트를 바로 내보낸다.
	MaxSkip int
	Now     func() time.Time
}

func (o *Options) setDefaults() {
	if o.MaxEventBytes <= 0 {
		o.MaxEventBytes = 1 << 20
	}
	if o.MaxWait <= 0 {
		o.MaxWait = 5 * time.Second
	}
	if o.MaxSkip <= 0 {
		o.MaxSkip = 256
	}
	if o.Now == nil {
		o.Now = time.Now
	}
}

// Meta는 기록의 첫 항목 정보다(계약 2.3절 stream, SD-02, SD-10). 없는 값은 0이고 Priority는 -1이다.
type Meta struct {
	Cursor           string
	RealtimeUS       int64
	SourceRealtimeUS int64
	Priority         int
	ContainerID      string
}

// Position은 재시작 위치다. 항목마다 따로 위치를 두지 않고 기록마다 이 값을 함께 대기에 확정한다.
type Position struct {
	// Cursor 항목까지는 모두 기록으로 냈거나 버렸다. 비면 journal 처음부터 읽는다.
	Cursor string
	// Ident는 Cursor 항목의 Ident다. 다시 시작할 때 그 항목이 아직 있는지 이 값으로 확인한다.
	Ident string
	// Skip은 Cursor 뒤에서 이미 처리한 항목의 Ident다. 나뉜 메시지의 앞 조각을 기다리는 동안 그
	// 뒤 항목으로 기록을 내면 Cursor는 앞 조각 앞에 머문다. 다시 읽을 때 이 항목들은 건너뛴다.
	Skip []string
	// DropKeys는 Cursor 뒤에서 버릴 나뉜 메시지 조각의 열쇠다. 시작 경계에서 쓰던 줄의 나머지와
	// 크기 상한을 넘은 줄의 나머지다.
	DropKeys []string
	// WaitStart는 D02 여러 줄: 첫 시작 줄을 기다리는 중이라는 뜻이다.
	WaitStart bool
}

// BoundaryInfo는 경계 기록의 내용이다.
type BoundaryInfo struct {
	Kind string
	// AtLineStart는 시작 경계에서 쓰던 줄이 없었는지다. 마지막 항목이 나뉜 메시지의 앞 조각이면
	// false이고 그 줄의 나머지는 버린다.
	AtLineStart bool
	// Dropped는 journald가 그 unit에서 버린 메시지 수다. 모르면 -1이다.
	Dropped int64
	Unit    string
	// ShareUnknown은 버린 수가 이 대상만의 수가 아니라는 뜻이다. 컨테이너 로그는 Docker 데몬이
	// 대신 보내므로 데몬 unit 하나의 한도를 그 서버의 컨테이너가 함께 쓴다.
	ShareUnknown bool
}

// Record는 대기에 넣을 기록 하나다. 이벤트·거부·경계 모두 순번 하나를 차지한다.
type Record struct {
	Kind       assemble.Kind
	Meta       Meta
	ObservedAt time.Time // 에이전트가 첫 조각을 읽은 시각(SD-01)
	Body       []byte    // Event만. 줄 사이는 "\n"으로 잇는다
	Flags      []string
	Reason     string // Rejected만
	LimitBytes int    // Rejected: 적용한 상한
	Boundary   BoundaryInfo
	After      Position
}

// mark는 읽은 항목 하나의 처리 여부다. 앞에서부터 처리된 항목만큼 재시작 위치를 옮긴다.
type mark struct {
	cursor, ident string
	done          bool
}

// part는 잇는 중인 나뉜 메시지다.
type part struct {
	marks  []*mark
	body   []byte
	over   bool
	meta   Meta
	seenAt time.Time
	lastAt time.Time
}

// line은 다 이은 줄 하나다.
type line struct {
	marks      []*mark
	body       []byte
	over       bool
	meta       Meta
	seenAt     time.Time
	incomplete bool
}

func (pt *part) line(incomplete bool) line {
	return line{marks: pt.marks, body: pt.body, over: pt.over, meta: pt.meta, seenAt: pt.seenAt, incomplete: incomplete}
}

// event는 묶는 중인 이벤트다.
type event struct {
	marks      []*mark
	lines      int
	body       []byte
	over       bool
	meta       Meta
	seenAt     time.Time
	incomplete bool
}

// Pipeline은 연결 하나의 항목을 기록으로 묶는다. 한 고루틴에서만 쓴다.
//
// 항목을 읽은 순서대로 장부(ledger)에 올리고, 기록을 낼 때 그 기록에 든 항목을 처리됨으로
// 표시한다. 장부 앞에서부터 처리된 항목까지가 재시작 위치(Cursor)다. Docker는 stdout과 stderr를
// 따로 보내므로 긴 줄의 조각 사이에 다른 줄이 끼일 수 있고, 그 줄을 먼저 내면 Cursor는 앞
// 조각 앞에 머물고 낸 줄은 Skip에 남는다.
type Pipeline struct {
	opt Options

	baseCursor, baseIdent string
	ledger                []*mark
	skip                  map[string]int
	drop                  map[string]bool
	parts                 map[string]*part
	ev                    *event
	waitStart             bool
	lastLine              time.Time
	unit                  string // 속도 제한 알림을 볼 unit
}

// NewPipeline은 Pipeline을 만든다. Multiline이면 StartPattern이 있어야 한다(설정 검사에서 막는다).
func NewPipeline(opt Options) *Pipeline {
	opt.setDefaults()
	p := &Pipeline{opt: opt, skip: map[string]int{}, drop: map[string]bool{}, parts: map[string]*part{}}
	switch opt.Target.Kind {
	case "unit":
		p.unit = opt.Target.Name
	case "container":
		// 컨테이너 항목의 _SYSTEMD_UNIT을 보면 그 값으로 바꾼다. 그 전에는 일반적인 이름을 쓴다.
		p.unit = "docker.service"
	}
	return p
}

// Initial은 최초 연결의 시작 경계 기록을 만든다. last는 그때 journal에서 대상과 속도 제한 알림
// 가운데 마지막 항목이고, 없으면 nil이다. 그 항목 뒤부터 새 로그로 읽는다(D02).
func (p *Pipeline) Initial(last *Entry) Record {
	b := BoundaryInfo{Kind: BoundaryInitialTail, AtLineStart: true}
	meta := Meta{Priority: -1}
	if last != nil {
		p.baseCursor, p.baseIdent = last.String(FieldCursor), last.Ident()
		meta.Cursor = p.baseCursor
		if key, final, _ := pieceOf(*last); key != "" && !final {
			// 연결 당시 쓰던 줄의 나머지 조각은 버린다(D02).
			p.drop[key] = true
			b.AtLineStart = false
		}
	}
	p.waitStart = p.opt.Format == assemble.Multiline
	return Record{Kind: assemble.Boundary, Meta: meta, ObservedAt: p.opt.Now(), Boundary: b, After: p.position()}
}

// Restore는 저장한 재시작 위치를 되살린다. 읽기는 pos.Cursor 항목 다음부터 다시 시작한다.
func (p *Pipeline) Restore(pos Position) {
	p.baseCursor, p.baseIdent = pos.Cursor, pos.Ident
	for _, s := range pos.Skip {
		p.skip[s]++
	}
	for _, k := range pos.DropKeys {
		p.drop[k] = true
	}
	p.waitStart = pos.WaitStart
}

// Push는 항목 하나를 받아 끝난 기록을 돌려준다.
func (p *Pipeline) Push(e Entry) []Record {
	now := p.opt.Now()
	id := e.Ident()
	m := &mark{cursor: e.String(FieldCursor), ident: id}
	p.ledger = append(p.ledger, m)
	if p.skip[id] > 0 {
		// 재시작 전에 이미 기록으로 낸 항목이다.
		if p.skip[id]--; p.skip[id] == 0 {
			delete(p.skip, id)
		}
		m.done = true
		return p.settle(nil)
	}
	if !p.isTarget(e) {
		if e.String(FieldMessageID) == MessageIDDropped {
			return p.settle(p.notice(nil, e, m, now))
		}
		m.done = true // 대상이 아닌 항목은 오지 않아야 하지만, 왔다면 건너뛴다
		return p.settle(nil)
	}
	if p.opt.Target.Kind == "container" {
		if u := e.String(FieldSystemdUnit); u != "" {
			p.unit = u
		}
	}

	var out []Record
	msg := e.Bytes(FieldMessage)
	over := e.Truncated(FieldMessage) || len(msg) > p.opt.MaxEventBytes
	key, final, cont := pieceOf(e)
	if key != "" && p.drop[key] {
		m.done = true
		if final {
			delete(p.drop, key)
		}
		return p.settle(nil)
	}
	pt := p.parts[key]
	if pt == nil {
		if final {
			// 나뉘지 않은 보통 줄이다. 앞 조각 없이 온 뒷조각이면 표시한다.
			l := line{marks: []*mark{m}, body: msg, over: over, meta: p.meta(e), seenAt: now, incomplete: cont}
			return p.settle(p.line(out, l))
		}
		pt = &part{meta: p.meta(e), seenAt: now}
		p.parts[key] = pt
	}
	pt.marks = append(pt.marks, m)
	pt.lastAt = now
	p.addPart(pt, msg, over)
	switch {
	case final:
		delete(p.parts, key)
		out = p.line(out, pt.line(false))
	case pt.over:
		// D03: 상한을 넘었다. 나머지 조각은 기다리지 않고 버리고 거부 기록 하나만 낸다.
		delete(p.parts, key)
		p.drop[key] = true
		out = p.line(out, pt.line(false))
	}
	return p.settle(out)
}

// Tick은 다음 조각이 MaxWait 동안 오지 않은 나뉜 메시지와, 다음 줄이 MaxWait 동안 오지 않은
// 여러 줄 이벤트를 끝낸다. 주기적으로 부른다.
func (p *Pipeline) Tick() []Record {
	now := p.opt.Now()
	var out []Record
	keys := make([]string, 0, len(p.parts))
	for k := range p.parts {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return p.parts[keys[i]].seenAt.Before(p.parts[keys[j]].seenAt) })
	for _, k := range keys {
		pt := p.parts[k]
		if now.Sub(pt.lastAt) >= p.opt.MaxWait {
			delete(p.parts, k)
			out = p.line(out, pt.line(true))
		}
	}
	if p.ev != nil && now.Sub(p.lastLine) >= p.opt.MaxWait {
		ev := p.ev
		p.ev = nil
		out = p.finish(out, ev)
	}
	return p.settle(out)
}

// pieceOf는 항목이 나뉜 메시지의 조각인지 본다. key는 같은 줄의 조각을 묶는 열쇠, final은 줄의
// 마지막 조각인지, cont는 앞 조각이 있어야 하는 뒷조각인지다.
//
// Docker journald 드라이버는 16KiB로 나눈 조각마다 CONTAINER_PARTIAL_ID·ORDINAL·LAST를 단다(2020년
// moby PR #41407 뒤). 그 전 판은 마지막이 아닌 조각에만 CONTAINER_PARTIAL_MESSAGE=true를 단다. 표시 없는 마지막
// 조각을 알아보려고, 나뉜 표시가 없는 컨테이너 항목도 같은 컨테이너·같은 출력(PRIORITY)의 열쇠를
// 돌려준다. systemd 서비스의 표준 출력은 LineMax를 넘으면 나뉘고 _LINE_BREAK=line-max가 붙는다.
func pieceOf(e Entry) (key string, final, cont bool) {
	switch {
	case e.Has(FieldPartialID):
		ord, _ := e.Int(FieldPartialOrdinal)
		return "p:" + e.String(FieldPartialID), e.String(FieldPartialLast) == "true", ord > 1
	case e.Has(FieldContainerIDFull):
		return "c:" + e.String(FieldContainerIDFull) + "/" + e.String(FieldPriority), e.String(FieldPartialMessage) != "true", false
	case e.Has(FieldStreamID):
		return "s:" + e.String(FieldStreamID), e.String(FieldLineBreak) != "line-max", false
	}
	return "", true, false
}

func (p *Pipeline) isTarget(e Entry) bool {
	switch p.opt.Target.Kind {
	case "container":
		return e.String(FieldContainerName) == p.opt.Target.Name
	case "unit":
		return e.String(FieldSystemdUnit) == p.opt.Target.Name
	}
	return false
}

// notice는 journald의 속도 제한 알림을 경계 기록으로 바꾼다. 다른 unit의 알림은 건너뛴다.
// 알림은 버린 구간이 끝난 뒤 그 unit의 다음 메시지가 올 때 남는다.
func (p *Pipeline) notice(out []Record, e Entry, m *mark, now time.Time) []Record {
	unit := e.String(FieldObjectUnit)
	if unit == "" {
		msg := e.String(FieldMessage)
		if i := strings.LastIndex(msg, " from "); i >= 0 {
			unit = msg[i+len(" from "):]
		}
	}
	if unit == "" || unit != p.unit {
		m.done = true
		return out
	}
	n, ok := e.Int(FieldNDropped)
	if !ok {
		n = -1
	}
	r := Record{Kind: assemble.Boundary, Meta: p.meta(e), ObservedAt: now, Boundary: BoundaryInfo{
		Kind: BoundarySourceDropped, Dropped: n, Unit: unit, ShareUnknown: p.opt.Target.Kind == "container",
	}}
	return p.emit(out, r, []*mark{m})
}

func (p *Pipeline) addPart(pt *part, msg []byte, over bool) {
	if pt.over {
		return
	}
	if over || len(pt.body)+len(msg) > p.opt.MaxEventBytes {
		pt.over = true
		head := append(pt.body, msg...)
		pt.body = bytes.Clone(head[:min(len(head), patternWindow)])
		return
	}
	pt.body = append(pt.body, msg...)
}

// line은 다 이은 줄을 형식에 따라 이벤트로 묶는다.
func (p *Pipeline) line(out []Record, l line) []Record {
	p.lastLine = p.opt.Now()
	if p.opt.Format != assemble.Multiline {
		ev := &event{marks: l.marks, lines: 1, body: l.body, over: l.over, meta: l.meta, seenAt: l.seenAt, incomplete: l.incomplete}
		return p.finish(out, ev)
	}
	isStart := p.opt.StartPattern.Match(l.body[:min(len(l.body), patternWindow)])
	if p.waitStart {
		if !isStart {
			// D02: 연결 전부터 쓰던 여러 줄 이벤트의 나머지다.
			for _, m := range l.marks {
				m.done = true
			}
			return out
		}
		p.waitStart = false
	}
	if isStart && p.ev != nil {
		ev := p.ev
		p.ev = nil
		out = p.finish(out, ev)
	}
	if p.ev == nil {
		p.ev = &event{meta: l.meta, seenAt: l.seenAt}
	}
	ev := p.ev
	ev.marks = append(ev.marks, l.marks...)
	ev.incomplete = ev.incomplete || l.incomplete
	switch {
	case ev.over:
	case l.over || len(ev.body)+1+len(l.body) > p.opt.MaxEventBytes:
		ev.over, ev.body = true, nil
	default:
		if ev.lines > 0 {
			ev.body = append(ev.body, '\n')
		}
		ev.body = append(ev.body, l.body...)
	}
	ev.lines++
	return out
}

// finish는 이벤트를 기록으로 낸다. 상한을 넘었으면 본문 없는 거부 기록이다(D03).
func (p *Pipeline) finish(out []Record, ev *event) []Record {
	r := Record{Meta: ev.meta, ObservedAt: ev.seenAt}
	if ev.over || len(ev.body) > p.opt.MaxEventBytes {
		r.Kind, r.Reason, r.LimitBytes = assemble.Rejected, assemble.ReasonTooLarge, p.opt.MaxEventBytes
	} else {
		r.Kind, r.Body = assemble.Event, bytes.Clone(ev.body)
		if ev.incomplete {
			r.Flags = []string{FlagIncomplete}
		}
	}
	return p.emit(out, r, ev.marks)
}

// emit은 기록에 든 항목을 처리됨으로 표시하고 그 뒤의 재시작 위치를 기록에 단다.
func (p *Pipeline) emit(out []Record, r Record, marks []*mark) []Record {
	for _, m := range marks {
		m.done = true
	}
	p.advance()
	r.After = p.position()
	return append(out, r)
}

// advance는 장부 앞에서부터 처리된 항목만큼 재시작 위치를 옮긴다.
func (p *Pipeline) advance() {
	i := 0
	for i < len(p.ledger) && p.ledger[i].done {
		p.baseCursor, p.baseIdent = p.ledger[i].cursor, p.ledger[i].ident
		i++
	}
	p.ledger = p.ledger[i:]
}

// settle은 재시작 위치를 옮기고, 처리한 항목 목록이 MaxSkip을 넘으면 재시작 위치를 붙잡고 있는
// 줄이나 이벤트를 바로 내보낸다. 목록이 재시작 위치와 함께 기록마다 저장되기 때문이다.
func (p *Pipeline) settle(out []Record) []Record {
	p.advance()
	for len(p.ledger) > 0 && !p.ledger[0].done && p.doneCount() > p.opt.MaxSkip {
		out = p.unblock(out, p.ledger[0])
		p.advance()
	}
	return out
}

func (p *Pipeline) doneCount() int {
	n := len(p.skip)
	for _, m := range p.ledger {
		if m.done {
			n++
		}
	}
	return n
}

// unblock은 항목 m을 붙잡고 있는 이벤트나 나뉜 메시지를 바로 내보낸다.
func (p *Pipeline) unblock(out []Record, m *mark) []Record {
	if p.ev != nil && contains(p.ev.marks, m) {
		ev := p.ev
		p.ev = nil
		return p.finish(out, ev)
	}
	for k, pt := range p.parts {
		if contains(pt.marks, m) {
			delete(p.parts, k)
			return p.line(out, pt.line(true))
		}
	}
	m.done = true // 붙잡은 곳이 없으면 장부가 어긋난 것이다. 멈추지 않도록 넘긴다
	return out
}

func contains(ms []*mark, m *mark) bool {
	for _, x := range ms {
		if x == m {
			return true
		}
	}
	return false
}

func (p *Pipeline) position() Position {
	pos := Position{Cursor: p.baseCursor, Ident: p.baseIdent, WaitStart: p.waitStart}
	for _, m := range p.ledger {
		if m.done {
			pos.Skip = append(pos.Skip, m.ident)
		}
	}
	rest := make([]string, 0, len(p.skip))
	for id, n := range p.skip {
		for range n {
			rest = append(rest, id)
		}
	}
	sort.Strings(rest)
	pos.Skip = append(pos.Skip, rest...)
	for k := range p.drop {
		pos.DropKeys = append(pos.DropKeys, k)
	}
	sort.Strings(pos.DropKeys)
	return pos
}

func (p *Pipeline) meta(e Entry) Meta {
	m := Meta{Cursor: e.String(FieldCursor), Priority: -1, ContainerID: e.String(FieldContainerIDFull)}
	m.RealtimeUS, _ = e.Int(FieldRealtime)
	m.SourceRealtimeUS, _ = e.Int(FieldSourceRealtime)
	if v, ok := e.Int(FieldPriority); ok && v >= 0 && v <= 7 {
		m.Priority = int(v)
	}
	return m
}
