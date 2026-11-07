// Package gen makes synthetic log events for the M1~M4 measurements.
// The same seed always gives the same events. No real log is used.
package gen

import (
	"fmt"
	"math/rand/v2"
	"sort"
	"time"
)

// Format is one of the log shapes in the measurement plan (section 3).
type Format string

const (
	N1 Format = "N1" // nginx access log, combined format
	T1 Format = "T1" // plain text, time without zone
	T2 Format = "T2" // plain text, Korean localized time
	J1 Format = "J1" // Pino JSON, level label
	J2 Format = "J2" // Pino JSON, numeric level
)

// Formats lists every format in a fixed order.
var Formats = []Format{N1, T1, T2, J1, J2}

// Needles are rare search terms planted at a fixed rate (plan section 3).
var Needles = []string{"PaymentGatewayTimeout", "환불 처리 지연"}

// Time flag bits (API contract 3.2, time_flags).
const (
	FlagFutureSuspect = 1
	FlagZoneGuessed   = 2
)

var kst = time.FixedZone("KST", 9*60*60)

// Source is one collection connection.
type Source struct {
	ConnectionID uint32
	ServiceID    uint32
	ServerID     uint32
	Format       Format
	StreamType   string // file or journald
	StreamID     string
	StreamLabel  string
	Host         string
	offset       uint64
	seq          uint64
	client       int // last nginx visitor, -1 when none
}

// Event is one stored record. Field names follow the API contract 3.2 logs table.
type Event struct {
	Src           *Source
	Seq           uint64
	Kind          string // event or rejected
	RefTime       time.Time
	ObservedAt    time.Time
	ReceivedAt    time.Time
	OccurredAt    *time.Time
	RefSource     string // body, envelope, observed
	TimeFlags     uint8
	Level         string
	LevelRaw      string
	Body          string
	BodyUnescaped string
	ParseStatus   string // none, ok, partial, failed
	Fields        map[string]any
	StreamOffset  *uint64
	JournalCursor string
	RejectReason  string
	RejectLimit   *uint64
}

// Config controls the generator.
type Config struct {
	Seed        uint64
	Start       time.Time // ref_time of the first event (Next)
	BytesPerDay int64     // body bytes per day; Next advances time by this rate
	NginxShare  float64   // share of events that are nginx access logs
	NeedleEvery int       // one needle per this many events on average; 0 disables
}

// DefaultConfig follows the measurement plan.
func DefaultConfig() Config {
	return Config{
		Seed:        1,
		Start:       time.Date(2026, 10, 25, 0, 0, 0, 0, time.UTC),
		BytesPerDay: 1 << 30,
		NginxShare:  0.5,
		NeedleEvery: 1_000_000,
	}
}

// Generator makes events. It is not safe for concurrent use.
type Generator struct {
	cfg     Config
	r       *rand.Rand
	sources []*Source
	nginx   []*Source
	apps    map[uint32][]*Source // by service
	svcIDs  []uint32
	t       time.Time
	carry   float64
	p       *pools
}

// New makes a generator.
func New(cfg Config) *Generator {
	r := rand.New(rand.NewPCG(cfg.Seed, cfg.Seed^0x9e3779b97f4a7c15))
	g := &Generator{cfg: cfg, r: r, t: cfg.Start, apps: map[uint32][]*Source{}}
	g.p = newPools(rand.New(rand.NewPCG(cfg.Seed+1, 42)), r)
	g.sources = Sources()
	for _, s := range g.sources {
		s.client = -1
		if s.Format == N1 {
			g.nginx = append(g.nginx, s)
		} else {
			g.apps[s.ServiceID] = append(g.apps[s.ServiceID], s)
		}
	}
	for id := range g.apps {
		g.svcIDs = append(g.svcIDs, id)
	}
	sort.Slice(g.svcIDs, func(i, j int) bool { return g.svcIDs[i] < g.svcIDs[j] })
	return g
}

// serviceFormats gives each service's app format so that by event count
// T1:T2:J1:J2 = 40:20:20:20 (plan section 3).
var serviceFormats = []Format{T1, T1, T2, J1, J2}

// serversPerService follows D16: 2 initial services with 2 servers each,
// 3 more services with 2, 2 and 3 servers.
var serversPerService = []int{2, 2, 2, 2, 3}

// Sources returns the 22 synthetic connections: per server one nginx and one app.
func Sources() []*Source {
	var out []*Source
	conn, server := uint32(1), uint32(1)
	for si, n := range serversPerService {
		svc := uint32(si + 1)
		for k := 0; k < n; k++ {
			host := fmt.Sprintf("svc%d-web-%02d", svc, k+1)
			out = append(out, &Source{
				ConnectionID: conn, ServiceID: svc, ServerID: server, Format: N1,
				StreamType: "file", StreamID: fmt.Sprintf("f:%d:%d", 2049, 100000+conn),
				StreamLabel: "/var/log/nginx/access.log", Host: host,
			})
			conn++
			f := serviceFormats[si]
			s := &Source{ConnectionID: conn, ServiceID: svc, ServerID: server, Format: f, Host: host}
			if f == J1 || f == J2 {
				s.StreamType = "journald"
				s.StreamID = fmt.Sprintf("j:CONTAINER_NAME=svc%d-api", svc)
				s.StreamLabel = fmt.Sprintf("journald svc%d-api", svc)
			} else {
				s.StreamType = "file"
				s.StreamID = fmt.Sprintf("f:%d:%d", 2049, 100000+conn)
				s.StreamLabel = fmt.Sprintf("/var/log/app/svc%d/app.log", svc)
			}
			out = append(out, s)
			conn++
			server++
		}
	}
	return out
}

// Next makes the next event and advances the clock so that body bytes
// arrive at Config.BytesPerDay.
func (g *Generator) Next() Event {
	e := g.At(g.t)
	size := float64(len(e.Body))
	if size == 0 {
		size = 1
	}
	step := float64(24*time.Hour) * size / float64(g.cfg.BytesPerDay)
	g.carry += step
	d := time.Duration(g.carry)
	g.carry -= float64(d)
	g.t = g.t.Add(d)
	return e
}

// Clock returns the ref_time the next Next call will use.
func (g *Generator) Clock() time.Time { return g.t }

// At makes one event whose reference time is t. Used for live ingest (M3·M4).
func (g *Generator) At(t time.Time) Event {
	t = t.UTC().Truncate(time.Microsecond)
	src := g.pickSource()
	src.seq++
	e := Event{Src: src, Seq: src.seq, Kind: "event", RefTime: t, RefSource: "body"}
	e.ObservedAt = t.Add(time.Duration(g.r.IntN(500_000)) * time.Microsecond)
	e.ReceivedAt = e.ObservedAt.Add(time.Duration(500_000+g.r.IntN(2_500_000)) * time.Microsecond)

	if g.r.IntN(10_000) == 0 {
		e.Kind = "rejected"
		e.RejectReason = "event_too_large"
		lim := uint64(1 << 20)
		e.RejectLimit = &lim
		e.Level = "UNKNOWN"
		e.ParseStatus = "none"
		e.Fields = map[string]any{}
		e.RefSource = "observed"
		e.RefTime = e.ObservedAt
		return e
	}

	needle := ""
	if g.cfg.NeedleEvery > 0 && g.r.IntN(g.cfg.NeedleEvery) == 0 {
		needle = Needles[g.r.IntN(len(Needles))]
	}
	switch src.Format {
	case N1:
		g.nginxEvent(&e, needle)
	case T1, T2:
		g.textEvent(&e, needle)
	case J1, J2:
		g.jsonEvent(&e, needle)
	}
	occ := e.RefTime
	e.OccurredAt = &occ
	if src.StreamType == "file" {
		off := src.offset
		e.StreamOffset = &off
		src.offset += uint64(len(e.Body)) + 1
	} else {
		e.JournalCursor = fmt.Sprintf("s=%032x;i=%x;b=%032x;m=%x;t=%x;x=%016x",
			uint64(src.ConnectionID)*7919, src.seq, uint64(src.ServiceID)*104729,
			t.UnixMicro()-1_700_000_000_000_000, t.UnixMicro(), src.seq*2654435761)
	}
	return e
}

func (g *Generator) pickSource() *Source {
	if g.r.Float64() < g.cfg.NginxShare {
		return g.nginx[g.r.IntN(len(g.nginx))]
	}
	svc := g.svcIDs[g.r.IntN(len(g.svcIDs))]
	list := g.apps[svc]
	return list[g.r.IntN(len(list))]
}

// pickLevel follows the plan's assumed distribution.
func (g *Generator) pickLevel() string {
	x := g.r.Float64()
	switch {
	case x < 0.80:
		return "INFO"
	case x < 0.88:
		return "DEBUG"
	case x < 0.95:
		return "WARN"
	case x < 0.995:
		return "ERROR"
	default:
		return "FATAL"
	}
}

// FieldPaths lists every leaf path of a nested field map, sorted.
func FieldPaths(m map[string]any) []string {
	var out []string
	var walk func(prefix string, v map[string]any)
	walk = func(prefix string, v map[string]any) {
		for k, x := range v {
			p := k
			if prefix != "" {
				p = prefix + "." + k
			}
			if sub, ok := x.(map[string]any); ok {
				walk(p, sub)
				continue
			}
			out = append(out, p)
		}
	}
	walk("", m)
	sort.Strings(out)
	return out
}

// Flatten turns nested fields into dotted paths split by value type,
// for the typed Map variant (V2).
func Flatten(m map[string]any) (str map[string]string, ints map[string]int64, floats map[string]float64, bools map[string]bool) {
	str, ints, floats, bools = map[string]string{}, map[string]int64{}, map[string]float64{}, map[string]bool{}
	var walk func(prefix string, v map[string]any)
	walk = func(prefix string, v map[string]any) {
		for k, x := range v {
			p := k
			if prefix != "" {
				p = prefix + "." + k
			}
			switch y := x.(type) {
			case map[string]any:
				walk(p, y)
			case string:
				str[p] = y
			case int:
				ints[p] = int64(y)
			case int64:
				ints[p] = y
			case float64:
				floats[p] = y
			case bool:
				bools[p] = y
			default:
				str[p] = fmt.Sprint(y)
			}
		}
	}
	walk("", m)
	return
}
