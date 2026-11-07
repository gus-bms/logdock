package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"strings"
	"time"

	"github.com/gus-bms/logdock/bench/internal/ch"
	"github.com/gus-bms/logdock/bench/internal/gen"
	"github.com/gus-bms/logdock/bench/internal/run"
	"github.com/gus-bms/logdock/bench/internal/schema"
)

type loadStats struct {
	Rows         int64            `json:"rows"`
	BodyBytes    int64            `json:"body_bytes"`
	JSONBytes    int64            `json:"insert_json_bytes"`
	ByFormat     map[string]int64 `json:"rows_by_format"`
	Batches      int              `json:"batches"`
	InsertSecs   float64          `json:"insert_seconds"`
	FirstRefTime string           `json:"first_ref_time"`
	LastRefTime  string           `json:"last_ref_time"`
}

func createTable(ctx context.Context, c *ch.Client, db, table string, v schema.Variant, fsync, replace bool) error {
	if err := validName(db); err != nil {
		return err
	}
	switch db {
	case "default", "system", "logdock":
		return fmt.Errorf("refusing to write to database %q; use a measurement database", db)
	}
	if err := c.Exec(ctx, "CREATE DATABASE IF NOT EXISTS "+db); err != nil {
		return err
	}
	if replace {
		if err := c.Exec(ctx, "DROP TABLE IF EXISTS "+db+"."+table+" SYNC"); err != nil {
			return err
		}
	}
	return c.Exec(ctx, schema.CreateTable(db, table, v, fsync))
}

// insertRows sends rows as one INSERT and returns its wall time.
func insertRows(ctx context.Context, c *ch.Client, db, table string, buf *bytes.Buffer) (time.Duration, error) {
	res, err := c.Do(ctx, ch.Request{SQL: "INSERT INTO " + db + "." + table + " FORMAT JSONEachRow", Data: bytes.NewReader(buf.Bytes())})
	return res.Wall, err
}

func encodeRow(enc *json.Encoder, e gen.Event, mode schema.FieldsMode) {
	enc.Encode(schema.ToRow(e, mode))
}

// loadUntil inserts generated events until the generator clock reaches end.
func loadUntil(ctx context.Context, c *ch.Client, db, table string, v schema.Variant, g *gen.Generator, end time.Time, batchRows int, guard *run.Guard, progress bool) (loadStats, error) {
	st := loadStats{ByFormat: map[string]int64{}}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	n := 0
	lastPrint := time.Now()
	flush := func() error {
		if n == 0 {
			return nil
		}
		if guard != nil {
			if err := guard.Check(); err != nil {
				return err
			}
		}
		st.JSONBytes += int64(buf.Len())
		d, err := insertRows(ctx, c, db, table, &buf)
		if err != nil {
			return err
		}
		st.InsertSecs += d.Seconds()
		st.Batches++
		buf.Reset()
		n = 0
		if progress && time.Since(lastPrint) > 10*time.Second {
			fmt.Printf("  %s rows=%d body=%.2f GB clock=%s\n", table, st.Rows, float64(st.BodyBytes)/1e9, g.Clock().Format(time.RFC3339))
			lastPrint = time.Now()
		}
		return nil
	}
	for g.Clock().Before(end) {
		if err := ctx.Err(); err != nil {
			return st, err
		}
		e := g.Next()
		if st.Rows == 0 {
			st.FirstRefTime = e.RefTime.Format(time.RFC3339Nano)
		}
		st.LastRefTime = e.RefTime.Format(time.RFC3339Nano)
		encodeRow(enc, e, v.Fields)
		st.Rows++
		st.BodyBytes += int64(len(e.Body))
		st.ByFormat[string(e.Src.Format)]++
		n++
		if n >= batchRows {
			if err := flush(); err != nil {
				return st, err
			}
		}
	}
	return st, flush()
}

func cmdLoad(ctx context.Context, args []string) (err error) {
	fs := flag.NewFlagSet("load", flag.ExitOnError)
	c := addCommon(fs)
	variant := fs.String("variant", "V1", "table variant V1~V5")
	set := fs.String("set", "d1", "data set name used in the default table name")
	table := fs.String("table", "", "table name (default <set>_<variant>)")
	gbPerDay := fs.Float64("gb-per-day", 1, "body gigabytes (10^9) per day")
	days := fs.Float64("days", 7, "days of data")
	hours := fs.Float64("hours", 0, "hours of data instead of days")
	start := fs.String("start", "2026-10-25", "first ref_time (date or RFC3339)")
	batch := fs.Int("batch-rows", 200_000, "rows per INSERT")
	optimize := fs.Bool("optimize", true, "OPTIMIZE TABLE FINAL afterwards so sizes are settled")
	replace := fs.Bool("replace", false, "drop the table first if it exists")
	fs.Parse(args)

	v, err := schema.Lookup(*variant)
	if err != nil {
		return err
	}
	if *table == "" {
		*table = *set + "_" + strings.ToLower(v.ID)
	}
	if err := validName(*table); err != nil {
		return err
	}
	t0, err := parseTime(*start)
	if err != nil {
		return err
	}
	span := time.Duration(*days * float64(24*time.Hour))
	if *hours > 0 {
		span = time.Duration(*hours * float64(time.Hour))
	}
	client, err := c.client()
	if err != nil {
		return err
	}
	guard := c.guard()
	if err := guard.Check(); err != nil {
		return err
	}
	r, err := run.New(c.out, "load-"+*table, args)
	if err != nil {
		return err
	}
	defer func() { r.Finish(err) }()

	if err := createTable(ctx, client, c.db, *table, v, false, *replace); err != nil {
		return err
	}
	cfg := gen.DefaultConfig()
	cfg.Seed = c.seed
	cfg.Start = t0
	cfg.BytesPerDay = int64(*gbPerDay * 1e9)
	g := gen.New(cfg)
	fmt.Printf("loading %s.%s variant=%s %.1f GB/day for %s from %s\n", c.db, *table, v.ID, *gbPerDay, span, t0.Format(time.RFC3339))
	began := time.Now()
	st, err := loadUntil(ctx, client, c.db, *table, v, g, t0.Add(span), *batch, &guard, true)
	r.Meta["load"] = st
	r.Meta["load_wall_seconds"] = time.Since(began).Seconds()
	r.Meta["gb_per_day"], r.Meta["span_hours"], r.Meta["variant"], r.Meta["table"] = *gbPerDay, span.Hours(), v.ID, *table
	if err != nil {
		return err
	}
	if *optimize {
		fmt.Println("optimizing (merging parts)...")
		ob := time.Now()
		if err := client.Exec(ctx, "OPTIMIZE TABLE "+c.db+"."+*table+" FINAL"); err != nil {
			return err
		}
		r.Meta["optimize_seconds"] = time.Since(ob).Seconds()
	}
	snapshot(ctx, client, r, c.db, []string{*table})
	fmt.Printf("done rows=%d body=%.2f GB insert=%.0fs results=%s\n", st.Rows, float64(st.BodyBytes)/1e9, st.InsertSecs, r.Dir)
	return nil
}

func cmdSizes(ctx context.Context, args []string) (err error) {
	fs := flag.NewFlagSet("sizes", flag.ExitOnError)
	c := addCommon(fs)
	tables := fs.String("tables", "", "comma separated tables (default all in the database)")
	fs.Parse(args)
	client, err := c.client()
	if err != nil {
		return err
	}
	r, err := run.New(c.out, "sizes", args)
	if err != nil {
		return err
	}
	defer func() { r.Finish(err) }()
	report, err := collectSizes(ctx, client, c.db, splitList(*tables))
	if err != nil {
		return err
	}
	snapshot(ctx, client, r, c.db, nil)
	printSizes(report)
	fmt.Println("results:", r.Dir)
	return r.WriteJSON("sizes.json", report)
}

type tableSize struct {
	Table          string           `json:"table"`
	Rows           int64            `json:"rows"`
	Parts          int64            `json:"active_parts"`
	BytesOnDisk    int64            `json:"bytes_on_disk"`
	Compressed     int64            `json:"data_compressed_bytes"`
	Uncompressed   int64            `json:"data_uncompressed_bytes"`
	BodyBytes      int64            `json:"body_bytes"`
	SpanHours      float64          `json:"ref_time_span_hours"`
	DiskPerDay     float64          `json:"bytes_on_disk_per_day"`
	SixMonthsBytes float64          `json:"six_months_estimate_bytes"`
	DiskPerBody    float64          `json:"disk_per_body_ratio"`
	Columns        []map[string]any `json:"columns"`
	Indexes        []map[string]any `json:"skipping_indexes"`
}

func num(v any) int64 {
	var n int64
	fmt.Sscan(fmt.Sprint(v), &n)
	return n
}

func collectSizes(ctx context.Context, c *ch.Client, db string, only []string) ([]tableSize, error) {
	p := map[string]string{"db": db}
	parts, err := c.Rows(ctx, "SELECT table, toInt64(sum(rows)) AS rows, toInt64(count()) AS parts, toInt64(sum(bytes_on_disk)) AS disk, toInt64(sum(data_compressed_bytes)) AS comp, toInt64(sum(data_uncompressed_bytes)) AS uncomp FROM system.parts WHERE database = {db:String} AND active GROUP BY table ORDER BY table", p)
	if err != nil {
		return nil, err
	}
	want := map[string]bool{}
	for _, t := range only {
		want[t] = true
	}
	var out []tableSize
	for _, row := range parts {
		name := fmt.Sprint(row["table"])
		if len(want) > 0 && !want[name] {
			continue
		}
		ts := tableSize{Table: name, Rows: num(row["rows"]), Parts: num(row["parts"]), BytesOnDisk: num(row["disk"]),
			Compressed: num(row["comp"]), Uncompressed: num(row["uncomp"])}
		span, err := c.Rows(ctx, fmt.Sprintf("SELECT toInt64(sum(length(body))) AS body, dateDiff('second', min(ref_time), max(ref_time)) AS secs FROM %s.%s", db, name), nil)
		if err != nil {
			return nil, err
		}
		if len(span) == 1 {
			ts.BodyBytes = num(span[0]["body"])
			ts.SpanHours = float64(num(span[0]["secs"])) / 3600
		}
		if ts.SpanHours > 0 {
			ts.DiskPerDay = float64(ts.BytesOnDisk) / (ts.SpanHours / 24)
			ts.SixMonthsBytes = ts.DiskPerDay * 183
		}
		if ts.BodyBytes > 0 {
			ts.DiskPerBody = float64(ts.BytesOnDisk) / float64(ts.BodyBytes)
		}
		tp := map[string]string{"db": db, "t": name}
		if ts.Columns, err = c.Rows(ctx, "SELECT name, data_compressed_bytes AS comp, data_uncompressed_bytes AS uncomp FROM system.columns WHERE database = {db:String} AND table = {t:String} ORDER BY data_compressed_bytes DESC", tp); err != nil {
			return nil, err
		}
		if ts.Indexes, err = c.Rows(ctx, "SELECT name, type_full, data_compressed_bytes AS comp FROM system.data_skipping_indices WHERE database = {db:String} AND table = {t:String}", tp); err != nil {
			return nil, err
		}
		out = append(out, ts)
	}
	return out, nil
}

func printSizes(rep []tableSize) {
	fmt.Printf("%-16s %12s %10s %10s %8s %12s %12s\n", "table", "rows", "body_GB", "disk_GB", "disk/body", "disk_GB/day", "6mo_GB")
	for _, t := range rep {
		fmt.Printf("%-16s %12d %10.3f %10.3f %7.1f%% %12.3f %12.1f\n", t.Table, t.Rows, float64(t.BodyBytes)/1e9,
			float64(t.BytesOnDisk)/1e9, t.DiskPerBody*100, t.DiskPerDay/1e9, t.SixMonthsBytes/1e9)
	}
}

func cmdDrop(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("drop", flag.ExitOnError)
	c := addCommon(fs)
	tables := fs.String("tables", "", "comma separated tables to drop")
	all := fs.Bool("all", false, "drop the whole measurement database")
	fs.Parse(args)
	client, err := c.client()
	if err != nil {
		return err
	}
	if *all {
		if err := validName(c.db); err != nil {
			return err
		}
		switch c.db {
		case "default", "system", "logdock":
			return fmt.Errorf("refusing to drop database %q; only measurement databases", c.db)
		}
		fmt.Println("dropping database", c.db)
		return client.Exec(ctx, "DROP DATABASE IF EXISTS "+c.db+" SYNC")
	}
	list := splitList(*tables)
	if len(list) == 0 {
		return fmt.Errorf("give -tables or -all")
	}
	for _, t := range list {
		if err := validName(t); err != nil {
			return err
		}
		fmt.Println("dropping", c.db+"."+t)
		if err := client.Exec(ctx, "DROP TABLE IF EXISTS "+c.db+"."+t+" SYNC"); err != nil {
			return err
		}
	}
	return nil
}
