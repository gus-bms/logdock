package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/gus-bms/logdock/bench/internal/gen"
	"github.com/gus-bms/logdock/bench/internal/queries"
	"github.com/gus-bms/logdock/bench/internal/run"
	"github.com/gus-bms/logdock/bench/internal/schema"
)

// cmdSmoke runs every step on tiny data so SQL and settings errors show up
// before the long runs. It drops its tables at the end.
func cmdSmoke(ctx context.Context, args []string) (err error) {
	fs := flag.NewFlagSet("smoke", flag.ExitOnError)
	c := addCommon(fs)
	keep := fs.Bool("keep", false, "keep the smoke tables")
	fs.Parse(args)
	client, err := c.client()
	if err != nil {
		return err
	}
	r, err := run.New(c.out, "smoke", args)
	if err != nil {
		return err
	}
	defer func() { r.Finish(err) }()
	guard := c.guard()
	if err := guard.Check(); err != nil {
		return err
	}
	snapshot(ctx, client, r, c.db, nil)
	fmt.Println("clickhouse", r.Meta["clickhouse_version"])

	var failures []string
	step := func(name string, f func() error) {
		began := time.Now()
		e := f()
		status := "ok"
		if e != nil {
			status = "FAIL: " + e.Error()
			failures = append(failures, name+": "+e.Error())
		}
		fmt.Printf("%-34s %-6s %s\n", name, time.Since(began).Round(time.Millisecond), status)
	}

	var tables []string
	start := time.Date(2026, 10, 30, 0, 0, 0, 0, time.UTC)
	for _, id := range schema.VariantIDs {
		v := schema.Variants[id]
		table := "smoke_" + strings.ToLower(id)
		tables = append(tables, table)
		step("create "+table, func() error { return createTable(ctx, client, c.db, table, v, false, true) })
		step("load "+table, func() error {
			cfg := gen.DefaultConfig()
			cfg.Seed, cfg.Start, cfg.BytesPerDay = c.seed, start, 5_000_000
			cfg.NeedleEvery = 2000
			_, err := loadUntil(ctx, client, c.db, table, v, gen.New(cfg), start.Add(48*time.Hour), 20_000, &guard, false)
			return err
		})
		step("optimize "+table, func() error { return client.Exec(ctx, "OPTIMIZE TABLE "+c.db+"."+table+" FINAL") })
		step("queries "+table, func() error {
			end, err := dataEnd(ctx, client, c.db, table)
			if err != nil {
				return err
			}
			from, to, _ := queries.Window("24h", end)
			for _, m := range []queries.Match{queries.MatchILike, queries.MatchLowerLike} {
				for _, q := range queries.Build(c.db, table, v, "24h", from, to, m) {
					mm := runQuery(ctx, client, q, fmt.Sprintf("%s-%s-%s-%s", r.ID, table, m, strings.ReplaceAll(q.ID, ".", "_")), nil)
					if mm.err != "" {
						return fmt.Errorf("%s %s: %s", m, q.ID, mm.err)
					}
				}
			}
			return nil
		})
	}
	step("needle found (S2, V1)", func() error {
		rows, err := client.Rows(ctx, "SELECT toInt64(count()) AS n FROM "+c.db+".smoke_v1 WHERE body ILIKE {w:String}", map[string]string{"w": queries.LikePattern("paymentgatewaytimeout")})
		if err != nil {
			return err
		}
		if len(rows) != 1 || num(rows[0]["n"]) == 0 {
			return fmt.Errorf("no needle rows")
		}
		return nil
	})
	step("field types kept (V1 JSON)", func() error {
		rows, err := client.Rows(ctx, "SELECT toInt64(countIf(isNotNull(fields.http.status.:Int64))) AS ints, toInt64(countIf(isNotNull(fields.res.statusCode.:String))) AS strs FROM "+c.db+".smoke_v1", nil)
		if err != nil {
			return err
		}
		if len(rows) != 1 || num(rows[0]["ints"]) == 0 || num(rows[0]["strs"]) == 0 {
			return fmt.Errorf("typed paths missing: %v", rows)
		}
		return nil
	})
	step("query log readable", func() error {
		_, err := queryLog(ctx, client, []string{r.ID + "-none"})
		return err
	})
	step("sizes", func() error {
		rep, err := collectSizes(ctx, client, c.db, tables)
		if err == nil {
			printSizes(rep)
			r.WriteJSON("sizes.json", rep)
		}
		return err
	})
	if os.Geteuid() == 0 {
		step("drop caches (cold path)", func() error {
			failed := map[string]string{}
			err := dropCaches(ctx, client, failed)
			if len(failed) > 0 {
				r.Meta["cache_drops_failed"] = failed
				fmt.Printf("  cache statements not available: %d (recorded, not fatal)\n", len(failed))
			}
			return err
		})
	} else {
		fmt.Println("drop caches (cold path)            skip   (run smoke with sudo to check)")
	}
	ingestTable := "smoke_ingest"
	tables = append(tables, ingestTable)
	step("ingest 10s with fsync", func() error {
		v := schema.Variants["V1"]
		if err := createTable(ctx, client, c.db, ingestTable, v, true, true); err != nil {
			return err
		}
		o := ingestOpts{db: c.db, table: ingestTable, variant: v, gbPerDay: 1, interval: time.Second, duration: 10 * time.Second, seed: c.seed + 100}
		res, err := ingestLoop(ctx, client, o, &guard, nil)
		if err == nil && (res.Errors > 0 || res.Inserts < 5) {
			err = fmt.Errorf("inserts=%d errors=%d", res.Inserts, res.Errors)
		}
		if err == nil {
			printIngest(res)
		}
		return err
	})
	step("memory sample", func() error {
		_, err := clickhouseMemory(client)(ctx)
		return err
	})
	if !*keep {
		step("drop smoke tables", func() error {
			for _, t := range tables {
				if err := client.Exec(ctx, "DROP TABLE IF EXISTS "+c.db+"."+t+" SYNC"); err != nil {
					return err
				}
			}
			return nil
		})
	}
	r.Meta["failures"] = failures
	fmt.Println("results:", r.Dir)
	if len(failures) > 0 {
		return fmt.Errorf("%d step(s) failed", len(failures))
	}
	fmt.Println("smoke OK")
	return nil
}
