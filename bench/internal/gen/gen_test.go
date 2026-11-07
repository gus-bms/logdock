package gen

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestSameSeedSameEvents(t *testing.T) {
	a, b := New(DefaultConfig()), New(DefaultConfig())
	for i := range 5000 {
		x, y := a.Next(), b.Next()
		if x.Body != y.Body || !x.RefTime.Equal(y.RefTime) || x.Src.ConnectionID != y.Src.ConnectionID || x.Seq != y.Seq {
			t.Fatalf("event %d differs", i)
		}
	}
}

func TestSources(t *testing.T) {
	src := Sources()
	if len(src) != 22 {
		t.Fatalf("want 22 connections, got %d", len(src))
	}
	seen := map[uint32]bool{}
	for _, s := range src {
		if seen[s.ConnectionID] {
			t.Fatalf("duplicate connection %d", s.ConnectionID)
		}
		seen[s.ConnectionID] = true
	}
}

var nginxLine = regexp.MustCompile(`^10\.\d+\.\d+\.\d+ - - \[\d{2}/[A-Z][a-z]{2}/\d{4}:\d{2}:\d{2}:\d{2} \+0900\] "(GET|POST|PUT|DELETE) \S+ HTTP/1\.1" \d{3} \d+ "[^"]*" "[^"]*" \d+\.\d{3}$`)
var t1Line = regexp.MustCompile(`^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (debug|info|warn|error) \[request-id: r-[0-9a-f]{6}\]: `)
var t2Line = regexp.MustCompile(`^\d{4}\. \d{1,2}\. \d{1,2}\. (오전|오후) \d{1,2}:\d{2}:\d{2} - ((debug|info|warn|error) )?\[\d+\]: `)

func TestFormats(t *testing.T) {
	g := New(DefaultConfig())
	counts := map[Format]int{}
	levels := map[string]int{}
	total := 0
	for range 200_000 {
		e := g.Next()
		if e.Kind != "event" {
			continue
		}
		total++
		counts[e.Src.Format]++
		levels[e.Level]++
		switch e.Src.Format {
		case N1:
			if e.ParseStatus == "ok" && !nginxLine.MatchString(e.Body) {
				t.Fatalf("bad nginx line: %q", e.Body)
			}
			if e.ParseStatus == "ok" {
				st := e.Fields["http"].(map[string]any)["status"]
				if _, ok := st.(int); !ok {
					t.Fatalf("nginx status is not int: %v", st)
				}
			}
		case T1:
			if !t1Line.MatchString(e.Body) {
				t.Fatalf("bad T1 line: %q", e.Body)
			}
		case T2:
			if !t2Line.MatchString(e.Body) {
				t.Fatalf("bad T2 line: %q", e.Body)
			}
		case J1, J2:
			body := e.Body
			if e.BodyUnescaped != "" {
				body = e.BodyUnescaped
			}
			var m map[string]any
			if err := json.Unmarshal([]byte(e.Body), &m); err != nil {
				t.Fatalf("bad JSON: %v %q", err, e.Body)
			}
			var m2 map[string]any
			if err := json.Unmarshal([]byte(body), &m2); err != nil || m2["msg"] != m["msg"] {
				t.Fatalf("escaped body does not decode to the same message")
			}
		}
		if e.TimeFlags&FlagZoneGuessed != 0 && e.Src.Format != T1 && e.Src.Format != T2 {
			t.Fatalf("zone flag on %s", e.Src.Format)
		}
	}
	share := float64(counts[N1]) / float64(total)
	if share < 0.48 || share > 0.52 {
		t.Fatalf("nginx share %.3f", share)
	}
	app := total - counts[N1]
	t1 := float64(counts[T1]) / float64(app)
	if t1 < 0.37 || t1 > 0.43 {
		t.Fatalf("T1 share of app logs %.3f", t1)
	}
	if levels["ERROR"] == 0 || levels["UNKNOWN"] == 0 {
		t.Fatalf("level mix missing values: %v", levels)
	}
}

func TestClockFollowsBytesPerDay(t *testing.T) {
	cfg := DefaultConfig()
	cfg.BytesPerDay = 100 << 20
	g := New(cfg)
	var bytes int64
	for bytes < 10<<20 {
		bytes += int64(len(g.Next().Body))
	}
	got := g.Clock().Sub(cfg.Start)
	want := 24 * time.Hour / 10
	if d := got - want; d < -time.Minute || d > time.Minute {
		t.Fatalf("10%% of a day's bytes took %v, want about %v", got, want)
	}
}

func TestNeedles(t *testing.T) {
	cfg := DefaultConfig()
	cfg.NeedleEvery = 1000
	g := New(cfg)
	n := 0
	for range 100_000 {
		e := g.Next()
		for _, w := range Needles {
			if strings.Contains(e.Body, w) || strings.Contains(e.Body, urlEscape(w)) || strings.Contains(e.BodyUnescaped, w) {
				n++
			}
		}
	}
	if n < 60 || n > 140 {
		t.Fatalf("needles %d, want about 100", n)
	}
}

func TestFieldHelpers(t *testing.T) {
	m := map[string]any{"a": 1, "b": map[string]any{"c": "x", "d": 1.5, "e": true}}
	got := strings.Join(FieldPaths(m), ",")
	if got != "a,b.c,b.d,b.e" {
		t.Fatalf("paths %s", got)
	}
	s, i, f, b := Flatten(m)
	if i["a"] != 1 || s["b.c"] != "x" || f["b.d"] != 1.5 || !b["b.e"] {
		t.Fatalf("flatten %v %v %v %v", s, i, f, b)
	}
}

// The field measurement kept about 5.8% after gzip (decisions 2026-11-07).
func TestNginxCompressionMatchesField(t *testing.T) {
	raw, comp, ratio := GzipRatio(DefaultConfig(), N1, 8<<20)
	t.Logf("N1 raw=%d gzip=%d ratio=%.2f%%", raw, comp, ratio*100)
	if ratio < 0.050 || ratio > 0.066 {
		t.Fatalf("N1 gzip ratio %.2f%%, want 5.0~6.6%%", ratio*100)
	}
}
