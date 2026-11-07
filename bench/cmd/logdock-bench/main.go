// Command logdock-bench runs the M1~M4 measurements on the central server
// (docs/planning/measurement-m1-m4-plan-v0.1.md). Commands that create
// tables or insert rows change the database and are run by the user.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gus-bms/logdock/bench/internal/ch"
	"github.com/gus-bms/logdock/bench/internal/run"
)

const usage = `logdock-bench: LogDock M1~M4 measurement tool (synthetic logs only)

Local (no database):
  sample     print synthetic lines
  calibrate  gzip ratio of one synthetic format
  ddl        print a table variant's CREATE TABLE

On the central server (create, insert or drop: run by the user):
  smoke      small end-to-end check of every command, then cleans up
  load       create a table and insert synthetic days (M1, M2 data)
  sizes      stored size per table and column, 6-month estimate (M1)
  query      search response times (M2)
  ingest     batch insert latency at a daily rate (M3)
  concurrent ingest while searchers run (M4)
  drop       drop measurement tables

Run "logdock-bench <command> -h" for flags.
`

type common struct {
	url, user, envFile, passKey, db, out, disk string
	minFreeGB                                  float64
	seed                                       uint64
}

func addCommon(fs *flag.FlagSet) *common {
	c := &common{}
	fs.StringVar(&c.url, "url", "http://127.0.0.1:8123", "ClickHouse HTTP address")
	fs.StringVar(&c.user, "user", "logdock_admin", "ClickHouse user")
	fs.StringVar(&c.envFile, "env-file", "/srv/logdock/.env", "file holding the password")
	fs.StringVar(&c.passKey, "password-key", "CLICKHOUSE_PASSWORD", "password key in env file")
	fs.StringVar(&c.db, "db", "bench", "measurement database")
	fs.StringVar(&c.out, "out", "/srv/logdock/bench-results", "result folder root")
	fs.StringVar(&c.disk, "disk", "/", "path whose file system is guarded")
	fs.Float64Var(&c.minFreeGB, "min-free-gb", 15, "stop inserting below this free space")
	fs.Uint64Var(&c.seed, "seed", 1, "generator seed")
	return c
}

func (c *common) client() (*ch.Client, error) {
	pw, err := ch.PasswordFromEnvFile(c.envFile, c.passKey)
	if err != nil {
		return nil, fmt.Errorf("read password: %w", err)
	}
	return &ch.Client{BaseURL: c.url, User: c.user, Password: pw}, nil
}

func (c *common) guard() run.Guard {
	return run.Guard{Path: c.disk, Min: uint64(c.minFreeGB * 1e9)}
}

func main() {
	if len(os.Args) < 2 || os.Args[1] == "-h" || os.Args[1] == "help" {
		fmt.Print(usage)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	cmds := map[string]func(context.Context, []string) error{
		"sample": cmdSample, "calibrate": cmdCalibrate, "ddl": cmdDDL,
		"smoke": cmdSmoke, "load": cmdLoad, "sizes": cmdSizes, "query": cmdQuery,
		"ingest": cmdIngest, "concurrent": cmdConcurrent, "drop": cmdDrop,
	}
	f, ok := cmds[os.Args[1]]
	if !ok {
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
	if err := f(ctx, os.Args[2:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

// snapshot records versions and settings that the results depend on.
func snapshot(ctx context.Context, c *ch.Client, r *run.Run, db string, tables []string) {
	if rows, err := c.Rows(ctx, "SELECT version() AS v", nil); err == nil && len(rows) == 1 {
		r.Meta["clickhouse_version"] = rows[0]["v"]
	}
	if rows, err := c.Rows(ctx, "SELECT name, value FROM system.server_settings WHERE name IN ('mark_cache_size', 'uncompressed_cache_size', 'index_mark_cache_size', 'max_server_memory_usage', 'max_server_memory_usage_to_ram_ratio', 'max_concurrent_queries')", nil); err == nil {
		r.Meta["server_settings"] = rows
	}
	ddl := map[string]any{}
	for _, t := range tables {
		if rows, err := c.Rows(ctx, "SHOW CREATE TABLE "+db+"."+t, nil); err == nil && len(rows) == 1 {
			ddl[t] = rows[0]["statement"]
		}
	}
	if len(ddl) > 0 {
		r.Meta["tables"] = ddl
	}
	if free, err := run.FreeBytes("/"); err == nil {
		r.Meta["free_bytes_at_start"] = free
	}
}

func clickhouseMemory(c *ch.Client) func(context.Context) (int64, error) {
	return func(ctx context.Context) (int64, error) {
		rows, err := c.Rows(ctx, "SELECT toInt64(value) AS v FROM system.metrics WHERE metric = 'MemoryTracking'", nil)
		if err != nil || len(rows) == 0 {
			return 0, err
		}
		var n int64
		fmt.Sscan(fmt.Sprint(rows[0]["v"]), &n)
		return n, nil
	}
}

func splitList(s string) []string {
	var out []string
	for _, x := range strings.Split(s, ",") {
		if x = strings.TrimSpace(x); x != "" {
			out = append(out, x)
		}
	}
	return out
}

func parseTime(s string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.UTC(), nil
	}
	return time.Parse("2006-01-02", s)
}

func validName(s string) error {
	if s == "" {
		return fmt.Errorf("empty name")
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_') {
			return fmt.Errorf("name %q: use lowercase letters, digits and _", s)
		}
	}
	return nil
}
