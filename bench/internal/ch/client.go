// Package ch is a small ClickHouse HTTP client for the measurements.
package ch

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Client talks to the ClickHouse HTTP interface.
type Client struct {
	BaseURL  string
	User     string
	Password string
	HTTP     *http.Client
}

// Summary is the X-ClickHouse-Summary header.
type Summary struct {
	ReadRows     int64
	ReadBytes    int64
	WrittenRows  int64
	WrittenBytes int64
	ElapsedNs    int64
}

// Result is one call's outcome.
type Result struct {
	Body    []byte
	Summary Summary
	Wall    time.Duration
}

// Request is one call. SQL goes in the body unless Data is set, then SQL
// goes in the URL and Data is the body (INSERT).
type Request struct {
	SQL      string
	Params   map[string]string // query parameters {name:Type}
	Settings map[string]string
	QueryID  string
	Data     io.Reader
}

// Do runs one request.
func (c *Client) Do(ctx context.Context, r Request) (Result, error) {
	q := url.Values{}
	for k, v := range r.Settings {
		q.Set(k, v)
	}
	for k, v := range r.Params {
		q.Set("param_"+k, v)
	}
	if r.QueryID != "" {
		q.Set("query_id", r.QueryID)
	}
	var body io.Reader = strings.NewReader(r.SQL)
	if r.Data != nil {
		q.Set("query", r.SQL)
		body = r.Data
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.BaseURL, "/")+"/?"+q.Encode(), body)
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("X-ClickHouse-User", c.User)
	req.Header.Set("X-ClickHouse-Key", c.Password)
	hc := c.HTTP
	if hc == nil {
		hc = http.DefaultClient
	}
	start := time.Now()
	resp, err := hc.Do(req)
	if err != nil {
		return Result{}, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	res := Result{Body: data, Wall: time.Since(start), Summary: parseSummary(resp.Header.Get("X-ClickHouse-Summary"))}
	if err != nil {
		return res, err
	}
	if resp.StatusCode != http.StatusOK {
		msg := strings.TrimSpace(string(data))
		if len(msg) > 800 {
			msg = msg[:800] + "..."
		}
		return res, fmt.Errorf("clickhouse %d: %s", resp.StatusCode, msg)
	}
	return res, nil
}

// Exec runs a statement without parameters.
func (c *Client) Exec(ctx context.Context, sql string) error {
	_, err := c.Do(ctx, Request{SQL: sql})
	return err
}

// Rows runs a query with FORMAT JSONEachRow appended and decodes each row.
func (c *Client) Rows(ctx context.Context, sql string, params map[string]string) ([]map[string]any, error) {
	res, err := c.Do(ctx, Request{SQL: sql + " FORMAT JSONEachRow", Params: params})
	if err != nil {
		return nil, err
	}
	var out []map[string]any
	sc := bufio.NewScanner(strings.NewReader(string(res.Body)))
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var m map[string]any
		d := json.NewDecoder(strings.NewReader(line))
		d.UseNumber()
		if err := d.Decode(&m); err != nil {
			return nil, fmt.Errorf("decode row: %w", err)
		}
		out = append(out, m)
	}
	return out, sc.Err()
}

func parseSummary(h string) Summary {
	if h == "" {
		return Summary{}
	}
	var m map[string]string
	if json.Unmarshal([]byte(h), &m) != nil {
		return Summary{}
	}
	n := func(k string) int64 { v, _ := strconv.ParseInt(m[k], 10, 64); return v }
	return Summary{ReadRows: n("read_rows"), ReadBytes: n("read_bytes"), WrittenRows: n("written_rows"),
		WrittenBytes: n("written_bytes"), ElapsedNs: n("elapsed_ns")}
}

// PasswordFromEnvFile reads KEY=value from a dotenv style file without
// printing it.
func PasswordFromEnvFile(path, key string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		k, v, ok := strings.Cut(strings.TrimSpace(sc.Text()), "=")
		if ok && strings.TrimSpace(k) == key {
			return strings.Trim(strings.TrimSpace(v), `"'`), nil
		}
	}
	if err := sc.Err(); err != nil {
		return "", err
	}
	return "", fmt.Errorf("%s not found in %s", key, path)
}
