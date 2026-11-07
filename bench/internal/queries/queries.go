// Package queries builds the M2 search queries (plan section 4, S1~S8).
// Search words are passed as ClickHouse query parameters, never joined
// into the SQL text (SD-15).
package queries

import (
	"fmt"
	"strings"
	"time"

	"github.com/gus-bms/logdock/bench/internal/schema"
)

// Match is how case-insensitive substring search is written.
type Match string

const (
	MatchILike     Match = "ilike"     // body ILIKE '%w%'
	MatchLowerLike Match = "lowerlike" // lowerUTF8(body) LIKE lower('%w%'), can use the V4 index
)

// Query is one SQL statement with its parameters.
type Query struct {
	ID     string // e.g. S1.list
	Search string // S1~S8
	Shape  string // list, count, hist, undetermined
	Range  string // 1h, 24h, 7d, all
	Match  Match
	SQL    string
	Params map[string]string
}

// LikePattern escapes LIKE wildcards so the word is matched as plain text
// (SD-15) and wraps it in %.
func LikePattern(word string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + r.Replace(word) + "%"
}

type search struct {
	id, word string
	extra    string // extra condition, may refer to {w:String}
	exclude  bool
}

var searches = []search{
	{id: "S1", word: "timeout"},
	{id: "S2", word: "paymentgatewaytimeout"},
	{id: "S3", word: "결제"},
	{id: "S4", word: "환불 처리 지연"},
	{id: "S5", word: "health", exclude: true, extra: "level IN ('WARN', 'ERROR', 'FATAL')"},
	{id: "S7", word: "timeout", extra: "service_id = 2"},
}

func textPred(m Match, negate bool) string {
	var p string
	if m == MatchLowerLike {
		p = "(lowerUTF8(body) LIKE lowerUTF8({w:String}) OR lowerUTF8(body_unescaped) LIKE lowerUTF8({w:String}))"
	} else {
		p = "(body ILIKE {w:String} OR body_unescaped ILIKE {w:String})"
	}
	if negate {
		return "NOT " + p
	}
	return p
}

// Ranges are the M2 windows ending at the end of the loaded data.
var Ranges = map[string]time.Duration{"1h": time.Hour, "24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour}

// Window returns [from, to) for a range name; "all" covers everything.
func Window(name string, end time.Time) (time.Time, time.Time, error) {
	if name == "all" {
		return time.Unix(0, 0).UTC(), end, nil
	}
	d, ok := Ranges[name]
	if !ok {
		return time.Time{}, time.Time{}, fmt.Errorf("unknown range %q", name)
	}
	return end.Add(-d), end, nil
}

// Build returns every M2 query for one table, range and match style.
func Build(db, table string, v schema.Variant, rangeName string, from, to time.Time, m Match) []Query {
	tbl := db + "." + table
	base := "ref_time >= {from:DateTime64(6, 'UTC')} AND ref_time < {to:DateTime64(6, 'UTC')} AND kind = 'event'"
	params := func(word string) map[string]string {
		p := map[string]string{
			"from": from.UTC().Format(schema.TimeLayout),
			"to":   to.UTC().Format(schema.TimeLayout),
		}
		if word != "" {
			p["w"] = LikePattern(word)
		}
		return p
	}
	var out []Query
	add := func(search, shape, sql, word string) {
		out = append(out, Query{
			ID: search + "." + shape, Search: search, Shape: shape, Range: rangeName, Match: m,
			SQL: sql, Params: params(word),
		})
	}
	for _, s := range searches {
		where := base + " AND " + textPred(m, s.exclude)
		if s.extra != "" {
			where += " AND " + s.extra
		}
		add(s.id, "list", fmt.Sprintf("SELECT ref_time, connection_id, seq, level, substring(body, 1, 2000) FROM %s WHERE %s ORDER BY ref_time DESC LIMIT 100", tbl, where), s.word)
		add(s.id, "count", fmt.Sprintf("SELECT count() FROM %s WHERE %s", tbl, where), s.word)
	}
	// S6 field condition http.status >= 500 and the undetermined count (SD-22).
	var match, undetermined string
	if v.Fields == schema.FieldsJSON {
		match = "fields.http.status.:Int64 >= 500"
		undetermined = "(parse_status = 'failed' OR (isNotNull(fields.http.status) AND isNull(fields.http.status.:Int64)))"
	} else {
		match = "fields_int['http.status'] >= 500"
		undetermined = "(parse_status = 'failed' OR (mapContains(fields_str, 'http.status') AND NOT mapContains(fields_int, 'http.status')))"
	}
	add("S6", "list", fmt.Sprintf("SELECT ref_time, connection_id, seq, level, substring(body, 1, 2000) FROM %s WHERE %s AND %s ORDER BY ref_time DESC LIMIT 100", tbl, base, match), "")
	add("S6", "count", fmt.Sprintf("SELECT count() FROM %s WHERE %s AND %s", tbl, base, match), "")
	add("S6", "undetermined", fmt.Sprintf("SELECT count() FROM %s WHERE %s AND %s", tbl, base, undetermined), "")
	// S8 per-minute volume over the whole window (SD-29).
	add("S8", "hist", fmt.Sprintf("SELECT toStartOfMinute(ref_time) AS m, count() FROM %s WHERE %s GROUP BY m ORDER BY m", tbl, base), "")
	return out
}

// Settings applied to every measured query so caches that would hide the
// real cost are off. Cold runs also drop server caches (see cmd).
var Settings = map[string]string{
	"use_query_cache":           "0",
	"use_query_condition_cache": "0",
}
