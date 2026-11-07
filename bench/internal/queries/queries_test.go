package queries

import (
	"strings"
	"testing"
	"time"

	"github.com/gus-bms/logdock/bench/internal/schema"
)

func TestLikePattern(t *testing.T) {
	if got := LikePattern(`50%_off\x`); got != `%50\%\_off\\x%` {
		t.Fatalf("got %s", got)
	}
}

func TestBuild(t *testing.T) {
	end := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	from, to, err := Window("24h", end)
	if err != nil || !to.Equal(end) || to.Sub(from) != 24*time.Hour {
		t.Fatalf("window %v %v %v", from, to, err)
	}
	for _, id := range schema.VariantIDs {
		v := schema.Variants[id]
		for _, m := range []Match{MatchILike, MatchLowerLike} {
			qs := Build("bench", "t", v, "24h", from, to, m)
			if len(qs) != 6*2+3+1 {
				t.Fatalf("%s: %d queries", id, len(qs))
			}
			for _, q := range qs {
				for _, w := range []string{"timeout", "결제", "환불", "health"} {
					if strings.Contains(q.SQL, w) {
						t.Fatalf("%s: search word %q is in SQL text", q.ID, w)
					}
				}
				if strings.Contains(q.SQL, "{w:String}") && q.Params["w"] == "" {
					t.Fatalf("%s: missing word parameter", q.ID)
				}
				if q.Params["from"] != "2026-10-31 00:00:00.000000" {
					t.Fatalf("%s: from %s", q.ID, q.Params["from"])
				}
				if v.Fields == schema.FieldsMaps && strings.Contains(q.SQL, "fields.http") {
					t.Fatalf("%s: JSON path on map variant", q.ID)
				}
			}
		}
	}
	if _, _, err := Window("2d", end); err == nil {
		t.Fatal("unknown range accepted")
	}
}
