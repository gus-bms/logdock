package schema

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/gus-bms/logdock/bench/internal/gen"
)

func TestCreateTableVariants(t *testing.T) {
	for _, id := range VariantIDs {
		v, err := Lookup(id)
		if err != nil {
			t.Fatal(err)
		}
		sql := CreateTable("bench", "d1_"+strings.ToLower(id), v, false)
		if !strings.Contains(sql, "ORDER BY "+v.OrderBy) {
			t.Fatalf("%s: order by missing", id)
		}
		if (v.Fields == FieldsJSON) != strings.Contains(sql, "fields             JSON") {
			t.Fatalf("%s: fields column wrong", id)
		}
		if v.TextIndex != strings.Contains(sql, "TYPE text(") {
			t.Fatalf("%s: text index wrong", id)
		}
		if strings.Contains(sql, "fsync_after_insert") {
			t.Fatalf("%s: fsync set without asking", id)
		}
		if strings.Count(sql, "(") != strings.Count(sql, ")") {
			t.Fatalf("%s: unbalanced parentheses", id)
		}
	}
	if !strings.Contains(CreateTable("bench", "x", Variants["V1"], true), "fsync_after_insert = 1") {
		t.Fatal("fsync setting missing")
	}
	if !strings.Contains(CreateTable("bench", "x", Variants["V6"], false), "fields             JSON CODEC(ZSTD(3))") {
		t.Fatal("V6 fields codec missing")
	}
	if _, err := Lookup("V9"); err == nil {
		t.Fatal("unknown variant accepted")
	}
}

func TestToRow(t *testing.T) {
	g := gen.New(gen.DefaultConfig())
	var sawJSON, sawMap bool
	for range 2000 {
		e := g.Next()
		if e.Kind != "event" || len(e.Fields) == 0 {
			continue
		}
		b, err := json.Marshal(ToRow(e, FieldsJSON))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(b), `"fields":{`) || strings.Contains(string(b), "fields_str") {
			t.Fatalf("JSON row wrong: %s", b)
		}
		sawJSON = true
		b, _ = json.Marshal(ToRow(e, FieldsMaps))
		if strings.Contains(string(b), `"fields":`) {
			t.Fatalf("map row has JSON fields: %s", b)
		}
		sawMap = true
		if !strings.Contains(string(b), `"ref_time":"2026-10-25 `) {
			t.Fatalf("time format: %s", b)
		}
	}
	if !sawJSON || !sawMap {
		t.Fatal("no rows with fields")
	}
}
