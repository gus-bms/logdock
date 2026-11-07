package journal

import (
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gus-bms/logdock/agent/internal/assemble"
)

// clock은 시험용 시계다.
type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func newClock() *clock { return &clock{t: time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC)} }

var seq int

// ent는 journal 파일에서 읽은 것 같은 항목을 만든다.
func ent(fields ...string) Entry {
	seq++
	return NewEntry(append([]string{
		FieldCursor + "=s=t;i=" + strconv.Itoa(seq),
		FieldRealtime + "=" + strconv.Itoa(1_762_400_000_000_000+seq),
		FieldMonotonic + "=" + strconv.Itoa(seq),
		FieldBootID + "=b",
	}, fields...)...)
}

// web은 컨테이너 web의 stdout(PRIORITY 6) 또는 stderr(3) 항목이다. extra가 기본 필드보다 앞선다
// (같은 필드는 첫 값만 쓴다).
func web(prio, msg string, extra ...string) Entry {
	return ent(append(extra, "CONTAINER_NAME=web", "CONTAINER_ID_FULL=cid1", "PRIORITY="+prio,
		"_SYSTEMD_UNIT=docker.service", "MESSAGE="+msg)...)
}

// piece는 Docker 20.10 뒤 형식의 나뉜 조각이다.
func piece(id string, ord int, last bool, msg string) Entry {
	extra := []string{"CONTAINER_PARTIAL_ID=" + id, "CONTAINER_PARTIAL_ORDINAL=" + strconv.Itoa(ord),
		"CONTAINER_PARTIAL_LAST=" + strconv.FormatBool(last)}
	if !last {
		extra = append(extra, "CONTAINER_PARTIAL_MESSAGE=true")
	}
	return web("6", msg, extra...)
}

func newPipe(c *clock, mod func(*Options)) *Pipeline {
	o := Options{Target: Target{Kind: "container", Name: "web"}, Format: assemble.Text, Now: c.now}
	if mod != nil {
		mod(&o)
	}
	return NewPipeline(o)
}

// show는 기록을 "종류 내용" 꼴로 바꾼다.
func show(rs []Record) []string {
	var out []string
	for _, r := range rs {
		switch r.Kind {
		case assemble.Event:
			s := "event " + string(r.Body)
			if len(r.Flags) > 0 {
				s += " " + strings.Join(r.Flags, ",")
			}
			out = append(out, s)
		case assemble.Rejected:
			out = append(out, "rejected "+r.Reason)
		default:
			out = append(out, fmt.Sprintf("boundary %s %d %s %v", r.Boundary.Kind, r.Boundary.Dropped, r.Boundary.Unit, r.Boundary.ShareUnknown))
		}
	}
	return out
}

func want(t *testing.T, got []Record, w ...string) {
	t.Helper()
	if g := show(got); !slices.Equal(g, w) {
		t.Fatalf("got %q\nwant %q", g, w)
	}
}

func pushAll(p *Pipeline, es ...Entry) []Record {
	var out []Record
	for _, e := range es {
		out = append(out, p.Push(e)...)
	}
	return out
}

func TestTextLinesBecomeEventsAndMoveCursor(t *testing.T) {
	p := newPipe(newClock(), nil)
	a, b := web("6", "hello"), web("3", "oops")
	rs := pushAll(p, a, b)
	want(t, rs, "event hello", "event oops")
	if rs[1].After.Cursor != b.String(FieldCursor) || rs[1].After.Ident != b.Ident() || len(rs[1].After.Skip) != 0 {
		t.Fatalf("after = %+v", rs[1].After)
	}
	if rs[0].Meta.Priority != 6 || rs[1].Meta.Priority != 3 || rs[0].Meta.ContainerID != "cid1" || rs[0].Meta.RealtimeUS == 0 {
		t.Fatalf("meta = %+v %+v", rs[0].Meta, rs[1].Meta)
	}
}

// Docker는 16KiB를 넘는 줄을 조각으로 나눈다. 조각을 이어 한 이벤트로 만든다.
func TestDockerPiecesJoin(t *testing.T) {
	p := newPipe(newClock(), nil)
	want(t, pushAll(p, piece("x", 1, false, "aaa"), piece("x", 2, false, "bbb"), piece("x", 3, true, "ccc")), "event aaabbbccc")

	// 20.10 전 형식: 마지막이 아닌 조각에만 표시가 있다.
	want(t, pushAll(p, web("6", "old-", "CONTAINER_PARTIAL_MESSAGE=true"), web("6", "style")), "event old-style")

	// systemd 서비스 표준 출력은 LineMax에서 나뉘고 _LINE_BREAK=line-max가 붙는다.
	u := newPipe(newClock(), func(o *Options) { o.Target = Target{Kind: "unit", Name: "order.service"} })
	svc := func(stream, msg string, extra ...string) Entry {
		return ent(append([]string{"_SYSTEMD_UNIT=order.service", "_STREAM_ID=" + stream, "MESSAGE=" + msg}, extra...)...)
	}
	want(t, pushAll(u, svc("s1", "long-", "_LINE_BREAK=line-max"), svc("s2", "other"), svc("s1", "line")),
		"event other", "event long-line")
}

// 긴 줄의 조각 사이에 다른 출력의 줄이 끼면 그 줄을 먼저 낸다. 재시작 위치는 앞 조각 앞에
// 머물고 먼저 낸 줄은 Skip에 둔다. 그 위치에서 다시 읽으면 같은 기록을 두 번 내지 않는다.
func TestInterleavedLineRestartsWithoutDuplicates(t *testing.T) {
	p := newPipe(newClock(), nil)
	start := web("6", "before")
	p1, b, p2 := piece("x", 1, false, "aaa"), web("3", "err line"), piece("x", 2, true, "bbb")
	rs := pushAll(p, start, p1, b, p2)
	want(t, rs, "event before", "event err line", "event aaabbb")
	mid := rs[1].After
	if mid.Cursor != start.String(FieldCursor) || !slices.Equal(mid.Skip, []string{b.Ident()}) {
		t.Fatalf("after interleaved line: %+v", mid)
	}
	if end := rs[2].After; end.Cursor != p2.String(FieldCursor) || len(end.Skip) != 0 {
		t.Fatalf("after joined line: %+v", end)
	}

	// 가운데 기록까지만 대기에 확정됐다고 보고 그 위치에서 다시 읽는다.
	q := newPipe(newClock(), nil)
	q.Restore(mid)
	rs2 := pushAll(q, p1, b, p2)
	want(t, rs2, "event aaabbb")
	if end := rs2[0].After; end.Cursor != p2.String(FieldCursor) || len(end.Skip) != 0 {
		t.Fatalf("after restart: %+v", end)
	}
}

// D03: 상한을 넘은 나뉜 줄은 거부 기록 하나만 내고 나머지 조각은 버린다.
func TestOversizedSplitLineIsRejectedOnce(t *testing.T) {
	p := newPipe(newClock(), func(o *Options) { o.MaxEventBytes = 8 })
	rs := pushAll(p, piece("x", 1, false, "12345"), piece("x", 2, false, "67890"))
	want(t, rs, "rejected event_too_large")
	if !slices.Equal(rs[0].After.DropKeys, []string{"p:x"}) {
		t.Fatalf("drop keys %v", rs[0].After.DropKeys)
	}
	rs = pushAll(p, piece("x", 3, true, "abc"), web("6", "next"))
	want(t, rs, "event next")
	if len(rs[0].After.DropKeys) != 0 {
		t.Fatalf("drop keys left: %v", rs[0].After.DropKeys)
	}
}

// D02: 최초 연결 때 마지막 항목이 쓰던 줄의 앞 조각이면 그 줄의 나머지는 버린다.
func TestInitialBoundaryDropsLineInProgress(t *testing.T) {
	for _, tc := range []struct {
		name       string
		last, rest Entry
	}{
		{"current docker", piece("y", 1, false, "head"), piece("y", 2, true, "tail")},
		{"old docker", web("6", "head", "CONTAINER_PARTIAL_MESSAGE=true"), web("6", "tail")},
	} {
		p := newPipe(newClock(), nil)
		b := p.Initial(&tc.last)
		if b.Boundary.AtLineStart || b.After.Cursor != tc.last.String(FieldCursor) || len(b.After.DropKeys) != 1 {
			t.Fatalf("%s: boundary %+v", tc.name, b)
		}
		want(t, pushAll(p, tc.rest, web("6", "new")), "event new")
	}
	p := newPipe(newClock(), nil)
	if b := p.Initial(nil); !b.Boundary.AtLineStart || b.After.Cursor != "" {
		t.Fatalf("empty journal boundary %+v", b)
	}
}

func TestMultilineGroupsWaitsForStartAndTicks(t *testing.T) {
	c := newClock()
	p := newPipe(c, func(o *Options) {
		o.Format, o.StartPattern = assemble.Multiline, regexp.MustCompile(`^\d{4}-`)
	})
	if b := p.Initial(nil); !b.After.WaitStart {
		t.Fatal("multiline must wait for the first start line after the initial boundary")
	}
	rs := pushAll(p, web("6", "  at old.Frame"), web("6", "2026-11-06 a"), web("6", "  at x.Y"), web("6", "2026-11-06 b"))
	want(t, rs, "event 2026-11-06 a\n  at x.Y")
	if rs[0].After.WaitStart {
		t.Fatal("wait flag must be cleared once a start line came")
	}
	want(t, p.Tick())
	c.t = c.t.Add(6 * time.Second)
	want(t, p.Tick(), "event 2026-11-06 b")
}

// 마지막 조각이 오지 않으면(Docker는 줄바꿈 없이 끝난 출력을 마지막 표시 없이 보낸다) 기다리다
// 받은 조각만 낸다. 늦게 온 뒷조각도 버리지 않고 따로 낸다.
func TestPieceWithoutLastIsReleasedAfterWait(t *testing.T) {
	c := newClock()
	p := newPipe(c, nil)
	want(t, pushAll(p, piece("z", 1, false, "partial")))
	c.t = c.t.Add(6 * time.Second)
	want(t, p.Tick(), "event partial incomplete")
	want(t, pushAll(p, piece("z", 2, true, "late")), "event late incomplete")
}

func TestRateLimitNotices(t *testing.T) {
	notice := func(unit string, n int, withObject bool) Entry {
		f := []string{"MESSAGE_ID=" + MessageIDDropped, "_SYSTEMD_UNIT=systemd-journald.service",
			fmt.Sprintf("MESSAGE=Suppressed %d messages from %s", n, unit), "N_DROPPED=" + strconv.Itoa(n)}
		if withObject {
			f = append(f, "OBJECT_SYSTEMD_UNIT="+unit)
		}
		return ent(f...)
	}
	u := newPipe(newClock(), func(o *Options) { o.Target = Target{Kind: "unit", Name: "order.service"} })
	other := notice("cron.service", 3, true)
	rs := pushAll(u, other, notice("order.service", 120, true), notice("order.service", 7, false))
	want(t, rs, "boundary source_dropped 120 order.service false", "boundary source_dropped 7 order.service false")
	if rs[0].After.Cursor == other.String(FieldCursor) {
		t.Fatal("cursor must move past the other unit's notice too")
	}

	// 컨테이너는 Docker 데몬 unit의 알림이다. 이 컨테이너의 몫은 모른다.
	c := newPipe(newClock(), nil)
	rs = pushAll(c, web("6", "x", "_SYSTEMD_UNIT=docker-alt.service"), notice("docker-alt.service", 50, true))
	want(t, rs, "event x", "boundary source_dropped 50 docker-alt.service true")
}

// 앞 조각이 오래 남아 Skip이 MaxSkip을 넘으면 그 조각을 바로 내보내 재시작 위치를 옮긴다.
func TestMaxSkipReleasesBlockingPiece(t *testing.T) {
	p := newPipe(newClock(), func(o *Options) { o.MaxSkip = 2 })
	rs := pushAll(p, piece("w", 1, false, "held"), web("3", "e1"), web("3", "e2"), web("3", "e3"))
	want(t, rs, "event e1", "event e2", "event e3", "event held incomplete")
	last := rs[len(rs)-1].After
	if len(last.Skip) != 0 {
		t.Fatalf("skip after release: %v", last.Skip)
	}
}
