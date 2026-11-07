package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/gus-bms/logdock/bench/internal/ch"
	"github.com/gus-bms/logdock/bench/internal/queries"
	"github.com/gus-bms/logdock/bench/internal/run"
	"github.com/gus-bms/logdock/bench/internal/schema"
)

// dataEnd returns just after the last ref_time in a table.
func dataEnd(ctx context.Context, c *ch.Client, db, table string) (time.Time, error) {
	rows, err := c.Rows(ctx, "SELECT formatDateTime(max(ref_time), '%Y-%m-%d %H:%i:%S.%f') AS t FROM "+db+"."+table, nil)
	if err != nil {
		return time.Time{}, err
	}
	if len(rows) != 1 {
		return time.Time{}, fmt.Errorf("no rows in %s", table)
	}
	t, err := time.Parse(schema.TimeLayout, fmt.Sprint(rows[0]["t"]))
	if err != nil {
		return time.Time{}, err
	}
	return t.Add(time.Microsecond), nil
}

// cacheDrops are tried before a cold run. Some may not exist in a version;
// failures are recorded, not fatal.
var cacheDrops = []string{
	"SYSTEM DROP MARK CACHE",
	"SYSTEM DROP UNCOMPRESSED CACHE",
	"SYSTEM DROP INDEX MARK CACHE",
	"SYSTEM DROP INDEX UNCOMPRESSED CACHE",
	"SYSTEM DROP QUERY CONDITION CACHE",
	"SYSTEM DROP QUERY CACHE",
	"SYSTEM DROP PAGE CACHE",
}

// dropCaches empties ClickHouse caches and the OS page cache (root only).
func dropCaches(ctx context.Context, c *ch.Client, failed map[string]string) error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("cold runs need root to drop the OS page cache; run with sudo or drop -cold")
	}
	for _, s := range cacheDrops {
		if err := c.Exec(ctx, s); err != nil {
			failed[s] = err.Error()
		}
	}
	syscall.Sync()
	return os.WriteFile("/proc/sys/vm/drop_caches", []byte("3\n"), 0o200)
}

type measured struct {
	q       queries.Query
	phase   string
	n       int
	id      string
	wall    time.Duration
	summary ch.Summary
	err     string
}

func runQuery(ctx context.Context, c *ch.Client, q queries.Query, id string, extra map[string]string) measured {
	settings := map[string]string{}
	for k, v := range queries.Settings {
		settings[k] = v
	}
	for k, v := range extra {
		settings[k] = v
	}
	res, err := c.Do(ctx, ch.Request{SQL: q.SQL, Params: q.Params, Settings: settings, QueryID: id})
	m := measured{q: q, id: id, wall: res.Wall, summary: res.Summary}
	if err != nil {
		m.err = err.Error()
	}
	return m
}

// queryLog reads duration and resource use for finished queries.
func queryLog(ctx context.Context, c *ch.Client, ids []string) (map[string]map[string]any, error) {
	out := map[string]map[string]any{}
	if len(ids) == 0 {
		return out, nil
	}
	if err := c.Exec(ctx, "SYSTEM FLUSH LOGS"); err != nil {
		return nil, err
	}
	for i := 0; i < len(ids); i += 200 {
		chunk := ids[i:min(i+200, len(ids))]
		arr := "['" + strings.Join(chunk, "','") + "']"
		rows, err := c.Rows(ctx, "SELECT query_id, query_duration_ms AS ms, read_rows, read_bytes, memory_usage, result_rows FROM system.query_log WHERE type = 'QueryFinish' AND event_date >= yesterday() AND query_id IN {ids:Array(String)}", map[string]string{"ids": arr})
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			out[fmt.Sprint(r["query_id"])] = r
		}
	}
	return out, nil
}

func cmdQuery(ctx context.Context, args []string) (err error) {
	fs := flag.NewFlagSet("query", flag.ExitOnError)
	c := addCommon(fs)
	table := fs.String("table", "d1_v1", "table to search")
	variant := fs.String("variant", "V1", "the table's variant")
	ranges := fs.String("ranges", "1h,24h,7d", "windows ending at the data's end (1h, 24h, 7d, all)")
	matches := fs.String("match", "ilike,lowerlike", "substring styles: ilike, lowerlike")
	only := fs.String("only", "", "only these searches, e.g. S1,S3")
	runs := fs.Int("runs", 5, "warm runs per query")
	cold := fs.Bool("cold", false, "one cold run first (drops caches; needs sudo)")
	fs.Parse(args)

	v, err := schema.Lookup(*variant)
	if err != nil {
		return err
	}
	if err := validName(*table); err != nil {
		return err
	}
	client, err := c.client()
	if err != nil {
		return err
	}
	if *cold && os.Geteuid() != 0 {
		return fmt.Errorf("-cold needs root to drop the OS page cache; run with sudo")
	}
	r, err := run.New(c.out, "query-"+*table, args)
	if err != nil {
		return err
	}
	defer func() { r.Finish(err) }()
	snapshot(ctx, client, r, c.db, []string{*table})
	end, err := dataEnd(ctx, client, c.db, *table)
	if err != nil {
		return err
	}
	r.Meta["data_end"] = end.Format(time.RFC3339Nano)
	want := map[string]bool{}
	for _, s := range splitList(*only) {
		want[strings.ToUpper(s)] = true
	}
	var all []measured
	failedDrops := map[string]string{}
	seq := 0
	for _, rg := range splitList(*ranges) {
		from, to, err := queries.Window(rg, end)
		if err != nil {
			return err
		}
		for _, mt := range splitList(*matches) {
			m := queries.Match(mt)
			if m != queries.MatchILike && m != queries.MatchLowerLike {
				return fmt.Errorf("unknown match %q", mt)
			}
			for _, q := range queries.Build(c.db, *table, v, rg, from, to, m) {
				if len(want) > 0 && !want[q.Search] {
					continue
				}
				if m == queries.MatchLowerLike && !strings.Contains(q.SQL, "{w:String}") {
					continue // same SQL as ilike; measured once
				}
				phases := []string{}
				if *cold {
					phases = append(phases, "cold")
				}
				for range *runs {
					phases = append(phases, "warm")
				}
				for i, ph := range phases {
					if err := ctx.Err(); err != nil {
						return err
					}
					if ph == "cold" {
						if err := dropCaches(ctx, client, failedDrops); err != nil {
							return err
						}
					}
					seq++
					id := fmt.Sprintf("%s-%05d", r.ID, seq)
					mm := runQuery(ctx, client, q, id, nil)
					mm.phase, mm.n = ph, i
					all = append(all, mm)
					if mm.err != "" {
						fmt.Printf("  %s %s %s %s: ERROR %s\n", rg, mt, q.ID, ph, mm.err)
					}
				}
				fmt.Printf("  %-4s %-9s %-16s done\n", rg, mt, q.ID)
			}
		}
	}
	if len(failedDrops) > 0 {
		r.Meta["cache_drops_failed"] = failedDrops
	}
	return writeQueryResults(ctx, client, r, all)
}

func writeQueryResults(ctx context.Context, c *ch.Client, r *run.Run, all []measured) error {
	ids := make([]string, 0, len(all))
	for _, m := range all {
		ids = append(ids, m.id)
	}
	logs, err := queryLog(ctx, c, ids)
	if err != nil {
		return err
	}
	out, err := r.CSV("m2.csv", "search", "shape", "range", "match", "phase", "run", "wall_ms", "duration_ms", "read_rows", "read_bytes", "memory_usage", "result_rows", "error")
	if err != nil {
		return err
	}
	type key struct{ search, shape, rng, match string }
	warm := map[key][]float64{}
	coldMs := map[key]float64{}
	readRows := map[key]string{}
	for _, m := range all {
		l := logs[m.id]
		dur := fmt.Sprint(l["ms"])
		if l == nil {
			dur = ""
		}
		out.Row(m.q.Search, m.q.Shape, m.q.Range, m.q.Match, m.phase, m.n, float64(m.wall.Microseconds())/1000, dur,
			l["read_rows"], l["read_bytes"], l["memory_usage"], l["result_rows"], m.err)
		k := key{m.q.Search, m.q.Shape, m.q.Range, string(m.q.Match)}
		ms := float64(m.wall.Microseconds()) / 1000
		if m.err != "" {
			continue
		}
		if m.phase == "cold" {
			coldMs[k] = ms
		} else {
			warm[k] = append(warm[k], ms)
		}
		readRows[k] = fmt.Sprint(l["read_rows"])
	}
	out.Close()
	var summary []map[string]any
	var keys []key
	for k := range warm {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := keys[i], keys[j]
		return a.rng+a.match+a.search+a.shape < b.rng+b.match+b.search+b.shape
	})
	fmt.Printf("%-4s %-9s %-16s %10s %10s %10s %14s\n", "rng", "match", "query", "cold_ms", "warm_med", "warm_max", "read_rows")
	for _, k := range keys {
		w := warm[k]
		sort.Float64s(w)
		cm, hasCold := coldMs[k]
		row := map[string]any{"search": k.search, "shape": k.shape, "range": k.rng, "match": k.match,
			"warm_median_ms": run.Percentile(w, 50), "warm_max_ms": w[len(w)-1], "read_rows": readRows[k]}
		coldTxt := "-"
		if hasCold {
			row["cold_ms"] = cm
			coldTxt = fmt.Sprintf("%.0f", cm)
		}
		summary = append(summary, row)
		fmt.Printf("%-4s %-9s %-16s %10s %10.0f %10.0f %14s\n", k.rng, k.match, k.search+"."+k.shape, coldTxt, run.Percentile(w, 50), w[len(w)-1], readRows[k])
	}
	fmt.Println("results:", r.Dir)
	return r.WriteJSON("m2-summary.json", summary)
}
