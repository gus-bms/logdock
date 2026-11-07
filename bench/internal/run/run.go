// Package run keeps one measurement run's result folder, disk guard and
// resource samples.
package run

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Run is one result folder.
type Run struct {
	ID    string
	Dir   string
	Start time.Time
	Meta  map[string]any
}

// New makes <root>/<time>-<name>. Files are readable by other accounts so
// the status-check account can read them (plan section 2).
func New(root, name string, args []string) (*Run, error) {
	start := time.Now().UTC()
	id := start.Format("20060102-150405") + "-" + name
	dir := filepath.Join(root, id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	os.Chmod(dir, 0o755)
	return &Run{ID: id, Dir: dir, Start: start, Meta: map[string]any{
		"command": name, "args": args, "started_at": start.Format(time.RFC3339),
	}}, nil
}

// WriteJSON writes name as indented JSON.
func (r *Run) WriteJSON(name string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(r.Dir, name), append(b, '\n'), 0o644)
}

// CSV is a CSV file that can be written from several goroutines.
type CSV struct {
	mu sync.Mutex
	f  *os.File
	w  *csv.Writer
}

// CSV opens name with a header.
func (r *Run) CSV(name string, header ...string) (*CSV, error) {
	f, err := os.OpenFile(filepath.Join(r.Dir, name), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return nil, err
	}
	c := &CSV{f: f, w: csv.NewWriter(f)}
	c.w.Write(header)
	return c, nil
}

// Row writes one record; values are formatted with fmt.
func (c *CSV) Row(vals ...any) {
	rec := make([]string, len(vals))
	for i, v := range vals {
		switch x := v.(type) {
		case float64:
			rec[i] = strconv.FormatFloat(x, 'f', 3, 64)
		case time.Time:
			rec[i] = x.UTC().Format("2006-01-02T15:04:05.000000Z")
		default:
			rec[i] = fmt.Sprint(x)
		}
	}
	c.mu.Lock()
	c.w.Write(rec)
	c.mu.Unlock()
}

// Close flushes and closes.
func (c *CSV) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.w.Flush()
	return c.f.Close()
}

// Finish writes meta.json.
func (r *Run) Finish(err error) {
	r.Meta["finished_at"] = time.Now().UTC().Format(time.RFC3339)
	r.Meta["seconds"] = time.Since(r.Start).Seconds()
	if err != nil {
		r.Meta["error"] = err.Error()
	}
	r.WriteJSON("meta.json", r.Meta)
}

// FreeBytes returns free bytes for unprivileged users on the file system of path.
func FreeBytes(path string) (uint64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, err
	}
	return uint64(st.Bavail) * uint64(st.Bsize), nil
}

// Guard stops work when free space drops under Min bytes (plan section 2).
type Guard struct {
	Path string
	Min  uint64
}

// Check returns an error when space is low.
func (g Guard) Check() error {
	free, err := FreeBytes(g.Path)
	if err != nil {
		return err
	}
	if free < g.Min {
		return fmt.Errorf("free space %.1f GB under the %.1f GB limit; stopped", float64(free)/1e9, float64(g.Min)/1e9)
	}
	return nil
}

// Sampler records host load and ClickHouse memory every interval.
type Sampler struct {
	Every  time.Duration
	Memory func(ctx context.Context) (int64, error) // ClickHouse MemoryTracking
	Out    *CSV
}

// Start runs until ctx ends.
func (s *Sampler) Start(ctx context.Context) {
	go func() {
		t := time.NewTicker(s.Every)
		defer t.Stop()
		prevBusy, prevTotal := cpuTimes()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-t.C:
				busy, total := cpuTimes()
				cpu := 0.0
				if total > prevTotal {
					cpu = 100 * float64(busy-prevBusy) / float64(total-prevTotal)
				}
				prevBusy, prevTotal = busy, total
				mem := int64(-1)
				if s.Memory != nil {
					if m, err := s.Memory(ctx); err == nil {
						mem = m
					}
				}
				s.Out.Row(now, cpu, loadAvg(), mem, memAvailable())
			}
		}
	}()
}

// SampleHeader is the Sampler CSV header.
var SampleHeader = []string{"time", "host_cpu_pct", "load1", "clickhouse_memory_bytes", "host_mem_available_bytes"}

func cpuTimes() (busy, total uint64) {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0, 0
	}
	line, _, _ := strings.Cut(string(b), "\n")
	f := strings.Fields(line)
	for i, v := range f[1:] {
		n, _ := strconv.ParseUint(v, 10, 64)
		total += n
		if i != 3 && i != 4 { // idle, iowait
			busy += n
		}
	}
	return busy, total
}

func loadAvg() string {
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return ""
	}
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return ""
	}
	return f[0]
}

func memAvailable() int64 {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return -1
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "MemAvailable:") {
			f := strings.Fields(line)
			if len(f) >= 2 {
				n, _ := strconv.ParseInt(f[1], 10, 64)
				return n * 1024
			}
		}
	}
	return -1
}

// Percentile returns the p-th percentile (0~100) of sorted values.
func Percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	i := int(float64(len(sorted)-1) * p / 100)
	return sorted[i]
}
