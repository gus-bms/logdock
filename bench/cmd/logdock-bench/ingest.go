package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gus-bms/logdock/bench/internal/ch"
	"github.com/gus-bms/logdock/bench/internal/gen"
	"github.com/gus-bms/logdock/bench/internal/queries"
	"github.com/gus-bms/logdock/bench/internal/run"
	"github.com/gus-bms/logdock/bench/internal/schema"
)

type ingestOpts struct {
	db, table string
	variant   schema.Variant
	gbPerDay  float64
	interval  time.Duration
	duration  time.Duration
	seed      uint64
}

type ingestResult struct {
	Inserts        int     `json:"inserts"`
	Rows           int64   `json:"rows"`
	BodyBytes      int64   `json:"body_bytes"`
	Errors         int     `json:"errors"`
	P50ms          float64 `json:"insert_p50_ms"`
	P95ms          float64 `json:"insert_p95_ms"`
	P99ms          float64 `json:"insert_p99_ms"`
	MaxMs          float64 `json:"insert_max_ms"`
	VisibleP95ms   float64 `json:"visible_delay_p95_ms"`
	ActiveParts    int64   `json:"active_parts_at_end"`
	MergesAtEnd    int64   `json:"merges_running_at_end"`
	AchievedGBDay  float64 `json:"achieved_gb_per_day"`
	IntervalMs     float64 `json:"interval_ms"`
	TargetGBPerDay float64 `json:"target_gb_per_day"`
}

// ingestLoop imitates the ingest server: every interval it inserts the
// events that arrived since the last insert as one synchronous INSERT
// (API contract 2.3, D17 section 5). Events get ref times spread over the
// interval, so the oldest one in a batch waited one interval plus the
// insert time before it became searchable (SD-28).
func ingestLoop(ctx context.Context, c *ch.Client, o ingestOpts, guard *run.Guard, out *run.CSV) (ingestResult, error) {
	cfg := gen.DefaultConfig()
	cfg.Seed = o.seed
	g := gen.New(cfg)
	rate := o.gbPerDay * 1e9 / 86400 // body bytes per second
	res := ingestResult{IntervalMs: float64(o.interval.Milliseconds()), TargetGBPerDay: o.gbPerDay}
	var lat, vis []float64
	last := time.Now()
	deadline := last.Add(o.duration)
	debt := 0.0
	t := time.NewTicker(o.interval)
	defer t.Stop()
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return res, ctx.Err()
		case <-t.C:
		}
		now := time.Now()
		window := now.Sub(last)
		debt += rate * window.Seconds()
		buf.Reset()
		rows, bytesIn := 0, int64(0)
		for debt > 0 {
			at := last.Add(time.Duration(float64(window) * float64(bytesIn) / (rate*window.Seconds() + 1)))
			e := g.At(at)
			encodeRow(enc, e, o.variant.Fields)
			rows++
			bytesIn += int64(len(e.Body))
			debt -= float64(len(e.Body))
		}
		last = now
		if guard != nil {
			if err := guard.Check(); err != nil {
				return res, err
			}
		}
		d, err := insertRows(ctx, c, o.db, o.table, &buf)
		ms := float64(d.Microseconds()) / 1000
		res.Inserts++
		errTxt := ""
		if err != nil {
			res.Errors++
			errTxt = err.Error()
		} else {
			res.Rows += int64(rows)
			res.BodyBytes += bytesIn
			lat = append(lat, ms)
			vis = append(vis, float64(window.Milliseconds())+ms)
		}
		if out != nil {
			out.Row(now, rows, bytesIn, ms, float64(window.Milliseconds())+ms, errTxt)
		}
		if ctx.Err() != nil {
			return res, ctx.Err()
		}
	}
	sort.Float64s(lat)
	sort.Float64s(vis)
	if len(lat) > 0 {
		res.P50ms, res.P95ms, res.P99ms, res.MaxMs = run.Percentile(lat, 50), run.Percentile(lat, 95), run.Percentile(lat, 99), lat[len(lat)-1]
		res.VisibleP95ms = run.Percentile(vis, 95)
	}
	res.AchievedGBDay = float64(res.BodyBytes) / o.duration.Seconds() * 86400 / 1e9
	p := map[string]string{"db": o.db, "t": o.table}
	if rows, err := c.Rows(ctx, "SELECT toInt64(count()) AS n FROM system.parts WHERE database = {db:String} AND table = {t:String} AND active", p); err == nil && len(rows) == 1 {
		res.ActiveParts = num(rows[0]["n"])
	}
	if rows, err := c.Rows(ctx, "SELECT toInt64(count()) AS n FROM system.merges WHERE database = {db:String} AND table = {t:String}", p); err == nil && len(rows) == 1 {
		res.MergesAtEnd = num(rows[0]["n"])
	}
	return res, nil
}

var ingestHeader = []string{"time", "rows", "body_bytes", "insert_ms", "visible_delay_ms", "error"}

func ingestFlags(fs *flag.FlagSet, defDuration time.Duration) (variant *string, table *string, gb *float64, interval, duration *time.Duration, fsync *bool) {
	variant = fs.String("variant", "V1", "table variant for the ingest table")
	table = fs.String("table", "", "ingest table (default ingest_f1 or ingest_f0)")
	gb = fs.Float64("gb-per-day", 10, "body gigabytes (10^9) per day")
	interval = fs.Duration("interval", time.Second, "how often the batched INSERT runs")
	duration = fs.Duration("duration", defDuration, "how long to run")
	fsync = fs.Bool("fsync", true, "fsync_after_insert = 1 on the ingest table")
	return
}

func cmdIngest(ctx context.Context, args []string) (err error) {
	fs := flag.NewFlagSet("ingest", flag.ExitOnError)
	c := addCommon(fs)
	variant, table, gb, interval, duration, fsync := ingestFlags(fs, 30*time.Minute)
	fs.Parse(args)
	o, client, err := prepareIngest(ctx, c, *variant, *table, *gb, *interval, *duration, *fsync)
	if err != nil {
		return err
	}
	r, err := run.New(c.out, "ingest-"+o.table, args)
	if err != nil {
		return err
	}
	defer func() { r.Finish(err) }()
	snapshot(ctx, client, r, c.db, []string{o.table})
	samples, _ := r.CSV("samples.csv", run.SampleHeader...)
	defer samples.Close()
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	(&run.Sampler{Every: 5 * time.Second, Memory: clickhouseMemory(client), Out: samples}).Start(sctx)
	out, err := r.CSV("m3.csv", ingestHeader...)
	if err != nil {
		return err
	}
	defer out.Close()
	guard := c.guard()
	fmt.Printf("ingesting into %s.%s at %.1f GB/day every %s for %s (fsync=%v)\n", c.db, o.table, o.gbPerDay, o.interval, o.duration, *fsync)
	res, err := ingestLoop(ctx, client, o, &guard, out)
	r.Meta["fsync_after_insert"] = *fsync
	if werr := r.WriteJSON("m3-summary.json", res); werr != nil && err == nil {
		err = werr
	}
	printIngest(res)
	fmt.Println("results:", r.Dir)
	return err
}

func prepareIngest(ctx context.Context, c *common, variant, table string, gb float64, interval, duration time.Duration, fsync bool) (ingestOpts, *ch.Client, error) {
	v, err := schema.Lookup(variant)
	if err != nil {
		return ingestOpts{}, nil, err
	}
	if table == "" {
		table = "ingest_f0"
		if fsync {
			table = "ingest_f1"
		}
	}
	if err := validName(table); err != nil {
		return ingestOpts{}, nil, err
	}
	client, err := c.client()
	if err != nil {
		return ingestOpts{}, nil, err
	}
	// Each run starts from an empty table so part counts are comparable.
	if err := createTable(ctx, client, c.db, table, v, fsync, true); err != nil {
		return ingestOpts{}, nil, err
	}
	return ingestOpts{db: c.db, table: table, variant: v, gbPerDay: gb, interval: interval, duration: duration, seed: c.seed + 100}, client, nil
}

func printIngest(r ingestResult) {
	fmt.Printf("inserts=%d errors=%d rows=%d achieved=%.2f GB/day\n", r.Inserts, r.Errors, r.Rows, r.AchievedGBDay)
	fmt.Printf("insert ms p50=%.1f p95=%.1f p99=%.1f max=%.1f; visible delay p95=%.0f ms; active parts=%d merges=%d\n",
		r.P50ms, r.P95ms, r.P99ms, r.MaxMs, r.VisibleP95ms, r.ActiveParts, r.MergesAtEnd)
}

func cmdConcurrent(ctx context.Context, args []string) (err error) {
	fs := flag.NewFlagSet("concurrent", flag.ExitOnError)
	c := addCommon(fs)
	variant, table, gb, interval, duration, fsync := ingestFlags(fs, 15*time.Minute)
	searchTable := fs.String("search-table", "d1_v1", "table the searchers read")
	searchVariant := fs.String("search-variant", "V1", "variant of the search table")
	searchers := fs.Int("searchers", 5, "concurrent searchers (Q15-03)")
	think := fs.Duration("think", 0, "pause between a searcher's queries")
	rng := fs.String("range", "7d", "search window")
	match := fs.String("match", "ilike", "substring style")
	only := fs.String("searches", "S1,S3,S5,S8", "searches each searcher cycles through")
	maxThreads := fs.Int("search-max-threads", 0, "max_threads for searches (0 = server default)")
	maxMem := fs.Int64("search-max-memory", 0, "max_memory_usage bytes for searches (0 = server default)")
	fs.Parse(args)

	sv, err := schema.Lookup(*searchVariant)
	if err != nil {
		return err
	}
	if err := validName(*searchTable); err != nil {
		return err
	}
	o, client, err := prepareIngest(ctx, c, *variant, *table, *gb, *interval, *duration, *fsync)
	if err != nil {
		return err
	}
	r, err := run.New(c.out, "concurrent-"+o.table, args)
	if err != nil {
		return err
	}
	defer func() { r.Finish(err) }()
	snapshot(ctx, client, r, c.db, []string{o.table, *searchTable})
	end, err := dataEnd(ctx, client, c.db, *searchTable)
	if err != nil {
		return err
	}
	from, to, err := queries.Window(*rng, end)
	if err != nil {
		return err
	}
	want := map[string]bool{}
	for _, s := range splitList(*only) {
		want[strings.ToUpper(s)] = true
	}
	var qs []queries.Query
	for _, q := range queries.Build(c.db, *searchTable, sv, *rng, from, to, queries.Match(*match)) {
		if want[q.Search] && q.Shape != "undetermined" {
			qs = append(qs, q)
		}
	}
	if len(qs) == 0 {
		return fmt.Errorf("no searches selected")
	}
	extra := map[string]string{}
	if *maxThreads > 0 {
		extra["max_threads"] = fmt.Sprint(*maxThreads)
	}
	if *maxMem > 0 {
		extra["max_memory_usage"] = fmt.Sprint(*maxMem)
	}
	r.Meta["search_settings"] = extra

	samples, _ := r.CSV("samples.csv", run.SampleHeader...)
	defer samples.Close()
	ingOut, err := r.CSV("m4-ingest.csv", ingestHeader...)
	if err != nil {
		return err
	}
	defer ingOut.Close()
	searchOut, err := r.CSV("m4-search.csv", "time", "searcher", "query", "wall_ms", "read_rows", "error")
	if err != nil {
		return err
	}
	defer searchOut.Close()

	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	(&run.Sampler{Every: 5 * time.Second, Memory: clickhouseMemory(client), Out: samples}).Start(sctx)

	var wg sync.WaitGroup
	var mu sync.Mutex
	var searchMs []float64
	searchErrs := 0
	for i := range *searchers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for n := i; sctx.Err() == nil; n++ {
				q := qs[n%len(qs)]
				m := runQuery(sctx, client, q, fmt.Sprintf("%s-s%d-%06d", r.ID, i, n), extra)
				if sctx.Err() != nil {
					return
				}
				ms := float64(m.wall.Microseconds()) / 1000
				searchOut.Row(time.Now(), i, q.ID, ms, m.summary.ReadRows, m.err)
				mu.Lock()
				if m.err == "" {
					searchMs = append(searchMs, ms)
				} else {
					searchErrs++
				}
				mu.Unlock()
				if *think > 0 {
					select {
					case <-sctx.Done():
						return
					case <-time.After(*think):
					}
				}
			}
		}()
	}
	guard := c.guard()
	fmt.Printf("ingesting %.1f GB/day into %s with %d searchers on %s (%s, think %s) for %s\n",
		o.gbPerDay, o.table, *searchers, *searchTable, *rng, *think, o.duration)
	res, err := ingestLoop(ctx, client, o, &guard, ingOut)
	cancel()
	wg.Wait()
	sort.Float64s(searchMs)
	sum := map[string]any{"ingest": res, "searches": len(searchMs), "search_errors": searchErrs}
	if len(searchMs) > 0 {
		sum["search_p50_ms"], sum["search_p95_ms"], sum["search_max_ms"] = run.Percentile(searchMs, 50), run.Percentile(searchMs, 95), searchMs[len(searchMs)-1]
	}
	if werr := r.WriteJSON("m4-summary.json", sum); werr != nil && err == nil {
		err = werr
	}
	printIngest(res)
	fmt.Printf("searches=%d errors=%d p50=%v p95=%v ms\n", len(searchMs), searchErrs, sum["search_p50_ms"], sum["search_p95_ms"])
	fmt.Println("results:", r.Dir)
	return err
}
