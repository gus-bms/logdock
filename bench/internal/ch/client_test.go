package ch

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDo(t *testing.T) {
	var gotQuery, gotBody, gotUser, gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		gotUser, gotKey = r.Header.Get("X-ClickHouse-User"), r.Header.Get("X-ClickHouse-Key")
		w.Header().Set("X-ClickHouse-Summary", `{"read_rows":"12","read_bytes":"340","written_rows":"0","written_bytes":"0","elapsed_ns":"5000"}`)
		if strings.Contains(gotBody, "bad") {
			w.WriteHeader(400)
			io.WriteString(w, "Code: 62. Syntax error")
			return
		}
		io.WriteString(w, "{\"c\":1}\n{\"c\":2}\n")
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, User: "u", Password: "p"}
	ctx := context.Background()

	res, err := c.Do(ctx, Request{SQL: "SELECT {w:String}", Params: map[string]string{"w": "%결제%"}, Settings: map[string]string{"use_query_cache": "0"}, QueryID: "q1"})
	if err != nil {
		t.Fatal(err)
	}
	if gotUser != "u" || gotKey != "p" {
		t.Fatal("auth headers missing")
	}
	if !strings.Contains(gotQuery, "param_w=") || !strings.Contains(gotQuery, "query_id=q1") || !strings.Contains(gotQuery, "use_query_cache=0") {
		t.Fatalf("query string %s", gotQuery)
	}
	if gotBody != "SELECT {w:String}" || res.Summary.ReadRows != 12 || res.Summary.ReadBytes != 340 {
		t.Fatalf("body %q summary %+v", gotBody, res.Summary)
	}

	if _, err := c.Do(ctx, Request{SQL: "INSERT INTO t FORMAT JSONEachRow", Data: strings.NewReader(`{"a":1}`)}); err != nil {
		t.Fatal(err)
	}
	if gotBody != `{"a":1}` || !strings.Contains(gotQuery, "query=INSERT") {
		t.Fatalf("insert body %q query %s", gotBody, gotQuery)
	}

	rows, err := c.Rows(ctx, "SELECT 1", nil)
	if err != nil || len(rows) != 2 {
		t.Fatalf("rows %v %v", rows, err)
	}
	if _, err := c.Do(ctx, Request{SQL: "bad"}); err == nil || !strings.Contains(err.Error(), "Syntax error") {
		t.Fatalf("want error, got %v", err)
	}
}

func TestPasswordFromEnvFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), ".env")
	os.WriteFile(p, []byte("A=1\nCLICKHOUSE_PASSWORD=abc123\n"), 0o600)
	got, err := PasswordFromEnvFile(p, "CLICKHOUSE_PASSWORD")
	if err != nil || got != "abc123" {
		t.Fatalf("%q %v", got, err)
	}
	if _, err := PasswordFromEnvFile(p, "NOPE"); err == nil {
		t.Fatal("missing key accepted")
	}
}
