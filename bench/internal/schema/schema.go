// Package schema holds the measurement table variants (plan section 3.2)
// and turns generated events into JSONEachRow rows.
package schema

import (
	"fmt"
	"strings"
	"time"

	"github.com/gus-bms/logdock/bench/internal/gen"
)

// FieldsMode is how parsed fields are stored.
type FieldsMode int

const (
	FieldsJSON FieldsMode = iota // fields JSON (contract 3.2)
	FieldsMaps                   // typed Map columns (V2)
)

// Variant is one table shape.
type Variant struct {
	ID          string
	Fields      FieldsMode
	OrderBy     string
	TextIndex   bool   // ngrams text index with lowerUTF8 preprocessor on body columns
	BodyCodec   string // empty for the default codec
	FieldsCodec string // codec for the JSON fields column; empty for default
}

// Variants in the plan. V1 is the API contract 3.2 DDL.
var Variants = map[string]Variant{
	"V1": {ID: "V1", Fields: FieldsJSON, OrderBy: "(ref_time, connection_id, generation, seq)"},
	"V2": {ID: "V2", Fields: FieldsMaps, OrderBy: "(ref_time, connection_id, generation, seq)"},
	"V3": {ID: "V3", Fields: FieldsJSON, OrderBy: "(service_id, ref_time, connection_id, generation, seq)"},
	"V4": {ID: "V4", Fields: FieldsJSON, OrderBy: "(ref_time, connection_id, generation, seq)", TextIndex: true},
	"V5": {ID: "V5", Fields: FieldsJSON, OrderBy: "(ref_time, connection_id, generation, seq)", BodyCodec: "ZSTD(3)"},
	// V6 combines V3's order with ZSTD on body and fields (2026-11-07 user
	// choice A for the D10·D50 scale runs).
	"V6": {ID: "V6", Fields: FieldsJSON, OrderBy: "(service_id, ref_time, connection_id, generation, seq)", BodyCodec: "ZSTD(3)", FieldsCodec: "ZSTD(3)"},
}

// VariantIDs is the fixed order for loops and help text.
var VariantIDs = []string{"V1", "V2", "V3", "V4", "V5", "V6"}

// Lookup returns a variant by ID.
func Lookup(id string) (Variant, error) {
	v, ok := Variants[strings.ToUpper(id)]
	if !ok {
		return Variant{}, fmt.Errorf("unknown variant %q (want one of %s)", id, strings.Join(VariantIDs, ", "))
	}
	return v, nil
}

// CreateTable returns the CREATE TABLE statement. fsync turns on
// fsync_after_insert (M3·M4).
func CreateTable(db, table string, v Variant, fsync bool) string {
	codec := ""
	if v.BodyCodec != "" {
		codec = " CODEC(" + v.BodyCodec + ")"
	}
	var fields string
	if v.Fields == FieldsJSON {
		fc := ""
		if v.FieldsCodec != "" {
			fc = " CODEC(" + v.FieldsCodec + ")"
		}
		fields = "    fields             JSON" + fc + ",\n"
	} else {
		fields = "    fields_str         Map(String, String),\n" +
			"    fields_int         Map(String, Int64),\n" +
			"    fields_float       Map(String, Float64),\n" +
			"    fields_bool        Map(String, Bool),\n"
	}
	index := ""
	if v.TextIndex {
		// ngrams(2) so that two-syllable Korean words such as 결제 can use the
		// index. ILIKE cannot use a text index, so the index is built on the
		// lowercased text and queries can use lowerUTF8(...) LIKE (plan M2).
		index = ",\n    INDEX idx_body body TYPE text(tokenizer = ngrams(2), preprocessor = lowerUTF8(body)) GRANULARITY 100000000" +
			",\n    INDEX idx_body_unescaped body_unescaped TYPE text(tokenizer = ngrams(2), preprocessor = lowerUTF8(body_unescaped)) GRANULARITY 100000000"
	}
	settings := "ttl_only_drop_parts = 1"
	if fsync {
		settings += ", fsync_after_insert = 1"
	}
	return fmt.Sprintf(`CREATE TABLE %s.%s
(
    connection_id      UInt32,
    generation         UInt16,
    seq                UInt64,
    kind               Enum8('event' = 1, 'rejected' = 2, 'boundary' = 3),
    service_id         UInt32,
    server_id          Nullable(UInt32),
    environment        LowCardinality(String),
    stream_type        Enum8('file' = 1, 'journald' = 2),
    stream_id          String,
    stream_label       String,
    stream_offset      Nullable(UInt64),
    journald_cursor    String,
    received_at        DateTime64(6, 'UTC'),
    observed_at        DateTime64(6, 'UTC'),
    occurred_at        Nullable(DateTime64(6, 'UTC')),
    ref_time           DateTime64(6, 'UTC'),
    ref_time_source    Enum8('body' = 1, 'envelope' = 2, 'observed' = 3),
    time_flags         UInt8,
    level              Enum8('UNKNOWN' = 0, 'TRACE' = 1, 'DEBUG' = 2, 'INFO' = 3,
                             'WARN' = 4, 'ERROR' = 5, 'FATAL' = 6),
    level_raw          String,
    body               String%[3]s,
    body_unescaped     String%[3]s,
    body_is_base64     Bool,
    parse_status       Enum8('none' = 0, 'ok' = 1, 'partial' = 2, 'failed' = 3),
    parse_rule_version UInt32,
%[4]s    field_paths        Array(String),
    fields_truncated   Bool,
    reject_reason      LowCardinality(String),
    reject_limit_bytes Nullable(UInt64),
    boundary_kind      LowCardinality(String),
    boundary_detail    String,
    INDEX idx_received   received_at   TYPE minmax GRANULARITY 1,
    INDEX idx_connection connection_id TYPE set(0) GRANULARITY 4,
    INDEX idx_service    service_id    TYPE set(0) GRANULARITY 4%[5]s
)
ENGINE = MergeTree
PARTITION BY toDate(received_at)
ORDER BY %[6]s
TTL toDateTime(received_at) + INTERVAL 6 MONTH DELETE
SETTINGS %[7]s`, db, table, codec, fields, index, v.OrderBy, settings)
}

// Row is one JSONEachRow line. Omitted columns take their defaults.
type Row struct {
	ConnectionID     uint32             `json:"connection_id"`
	Generation       uint16             `json:"generation"`
	Seq              uint64             `json:"seq"`
	Kind             string             `json:"kind"`
	ServiceID        uint32             `json:"service_id"`
	ServerID         uint32             `json:"server_id"`
	Environment      string             `json:"environment"`
	StreamType       string             `json:"stream_type"`
	StreamID         string             `json:"stream_id"`
	StreamLabel      string             `json:"stream_label"`
	StreamOffset     *uint64            `json:"stream_offset"`
	JournaldCursor   string             `json:"journald_cursor"`
	ReceivedAt       string             `json:"received_at"`
	ObservedAt       string             `json:"observed_at"`
	OccurredAt       *string            `json:"occurred_at"`
	RefTime          string             `json:"ref_time"`
	RefTimeSource    string             `json:"ref_time_source"`
	TimeFlags        uint8              `json:"time_flags"`
	Level            string             `json:"level"`
	LevelRaw         string             `json:"level_raw"`
	Body             string             `json:"body"`
	BodyUnescaped    string             `json:"body_unescaped"`
	ParseStatus      string             `json:"parse_status"`
	ParseRuleVersion uint32             `json:"parse_rule_version"`
	Fields           map[string]any     `json:"fields,omitempty"`
	FieldsStr        map[string]string  `json:"fields_str,omitempty"`
	FieldsInt        map[string]int64   `json:"fields_int,omitempty"`
	FieldsFloat      map[string]float64 `json:"fields_float,omitempty"`
	FieldsBool       map[string]bool    `json:"fields_bool,omitempty"`
	FieldPaths       []string           `json:"field_paths"`
	RejectReason     string             `json:"reject_reason,omitempty"`
	RejectLimitBytes *uint64            `json:"reject_limit_bytes,omitempty"`
}

// TimeLayout is the DateTime64(6) text form ClickHouse reads in JSONEachRow.
const TimeLayout = "2006-01-02 15:04:05.000000"

func ts(t time.Time) string { return t.UTC().Format(TimeLayout) }

// ToRow converts an event for the given fields mode.
func ToRow(e gen.Event, mode FieldsMode) Row {
	r := Row{
		ConnectionID: e.Src.ConnectionID, Generation: 1, Seq: e.Seq, Kind: e.Kind,
		ServiceID: e.Src.ServiceID, ServerID: e.Src.ServerID, Environment: "prod",
		StreamType: e.Src.StreamType, StreamID: e.Src.StreamID, StreamLabel: e.Src.StreamLabel,
		StreamOffset: e.StreamOffset, JournaldCursor: e.JournalCursor,
		ReceivedAt: ts(e.ReceivedAt), ObservedAt: ts(e.ObservedAt), RefTime: ts(e.RefTime),
		RefTimeSource: e.RefSource, TimeFlags: e.TimeFlags, Level: e.Level, LevelRaw: e.LevelRaw,
		Body: e.Body, BodyUnescaped: e.BodyUnescaped, ParseStatus: e.ParseStatus, ParseRuleVersion: 1,
		FieldPaths: gen.FieldPaths(e.Fields), RejectReason: e.RejectReason, RejectLimitBytes: e.RejectLimit,
	}
	if e.OccurredAt != nil {
		s := ts(*e.OccurredAt)
		r.OccurredAt = &s
	}
	if r.FieldPaths == nil {
		r.FieldPaths = []string{}
	}
	if len(e.Fields) > 0 {
		if mode == FieldsJSON {
			r.Fields = e.Fields
		} else {
			r.FieldsStr, r.FieldsInt, r.FieldsFloat, r.FieldsBool = gen.Flatten(e.Fields)
		}
	}
	return r
}
