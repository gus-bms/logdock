package main

import (
	"context"
	"flag"
	"fmt"

	"github.com/gus-bms/logdock/bench/internal/gen"
	"github.com/gus-bms/logdock/bench/internal/schema"
)

func cmdSample(_ context.Context, args []string) error {
	fs := flag.NewFlagSet("sample", flag.ExitOnError)
	format := fs.String("format", "", "only this format (N1, T1, T2, J1, J2); empty for all")
	n := fs.Int("n", 10, "lines to print")
	seed := fs.Uint64("seed", 1, "generator seed")
	fs.Parse(args)
	cfg := gen.DefaultConfig()
	cfg.Seed = *seed
	g := gen.New(cfg)
	for printed := 0; printed < *n; {
		e := g.Next()
		if e.Kind != "event" || (*format != "" && string(e.Src.Format) != *format) {
			continue
		}
		fmt.Printf("%s conn=%d %s %s | %s\n", e.Src.Format, e.Src.ConnectionID, e.RefTime.Format("2006-01-02T15:04:05.000000Z"), e.Level, e.Body)
		printed++
	}
	return nil
}

func cmdCalibrate(_ context.Context, args []string) error {
	fs := flag.NewFlagSet("calibrate", flag.ExitOnError)
	format := fs.String("format", "N1", "format to measure")
	mb := fs.Int("mb", 50, "raw megabytes to generate")
	seed := fs.Uint64("seed", 1, "generator seed")
	fs.Parse(args)
	cfg := gen.DefaultConfig()
	cfg.Seed = *seed
	raw, comp, ratio := gen.GzipRatio(cfg, gen.Format(*format), int64(*mb)*1_000_000)
	fmt.Printf("format=%s raw=%d gzip=%d ratio=%.2f%%\n", *format, raw, comp, ratio*100)
	return nil
}

func cmdDDL(_ context.Context, args []string) error {
	fs := flag.NewFlagSet("ddl", flag.ExitOnError)
	variant := fs.String("variant", "V1", "V1~V5")
	table := fs.String("table", "logs_v1", "table name")
	fsync := fs.Bool("fsync", false, "fsync_after_insert = 1")
	fs.Parse(args)
	v, err := schema.Lookup(*variant)
	if err != nil {
		return err
	}
	fmt.Println(schema.CreateTable("bench", *table, v, *fsync) + ";")
	return nil
}
