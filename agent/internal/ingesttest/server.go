// Package ingesttest는 시험용 가짜 수신 서버다. 계약 초안 2절의 묶음 수신과 세대 발급을
// 최소한으로 흉내 내고, 장애를 끼워 넣어 에이전트의 재시도·보류를 시험한다.
// 실제 수신 서버(ingest-prototype)가 아니다.
package ingesttest

import (
	"compress/gzip"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gus-bms/logdock/agent/internal/record"
)

// Protocol은 이 서버가 받는 규약 버전이다.
const Protocol = 1

// Fault는 다음 묶음 요청 하나에 끼워 넣을 장애다.
type Fault struct {
	Status      int
	Code        string
	StoreFirst  bool   // 묶음을 저장한 뒤 이 오류로 답한다. 응답을 잃은 상황이다
	RetryAfter  string // 429일 때 Retry-After 값
	ExpectedSeq uint64 // seq_gap일 때. 0이면 서버의 실제 다음 순번
}

// Stored는 서버가 저장한 기록 하나다.
type Stored struct {
	Generation    uint16
	ConfigVersion int
	Record        record.Wire
}

type batch struct {
	Protocol      int           `json:"protocol"`
	ConnectionID  string        `json:"connection_id"`
	Generation    uint16        `json:"generation"`
	ConfigVersion int           `json:"config_version"`
	Records       []record.Wire `json:"records"`
}

type keyState struct {
	conn    string
	revoked bool
}

type conn struct {
	archived bool
	maxGen   uint16
	next     map[uint16]uint64 // 세대마다 다음 순번
	stored   []Stored
	reports  []map[string]any // 받은 상태 보고
}

// Server는 TLS로 뜨는 가짜 수신 서버다. Client()로 그 인증서를 믿는 클라이언트를 얻는다.
type Server struct {
	*httptest.Server
	mu         sync.Mutex
	keys       map[string]keyState
	conns      map[string]*conn
	faults     []Fault
	limitBytes int
	duplicates int
}

// New는 서버를 띄운다. 시험이 끝나면 Close한다.
func New() *Server {
	s := &Server{keys: map[string]keyState{}, conns: map[string]*conn{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /ingest/v1/batches", s.handleBatches)
	mux.HandleFunc("POST /ingest/v1/generations", s.handleGenerations)
	mux.HandleFunc("POST /ingest/v1/status", s.handleStatus)
	s.Server = httptest.NewTLSServer(mux)
	return s
}

// WriteCA는 이 서버의 인증서를 PEM 파일로 쓴다. 에이전트 설정의 ca_file로 쓴다.
func (s *Server) WriteCA(path string) error {
	b := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: s.Certificate().Raw})
	return os.WriteFile(path, b, 0o644)
}

// Reports는 연결이 보낸 상태 보고를 받은 순서대로 돌려준다.
func (s *Server) Reports(connID string) []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]map[string]any(nil), s.conns[connID].reports...)
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	connID, code := s.auth(r)
	if code != "" {
		writeError(w, http.StatusUnauthorized, code, 0)
		return
	}
	var rep map[string]any
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&rep); err != nil || rep["connection_id"] != connID {
		writeError(w, http.StatusBadRequest, "bad_batch", 0)
		return
	}
	c := s.conns[connID]
	c.reports = append(c.reports, rep)
	state := "active"
	if c.archived {
		state = "archived"
	}
	writeJSON(w, http.StatusOK, map[string]any{"server_time": time.Now().UTC(), "connection_state": state})
}

// IngestURL은 에이전트 설정의 ingest_url 값이다.
func (s *Server) IngestURL() string { return s.Server.URL + "/ingest/v1" }

// AddConnection은 수집 연결과 그 키를 등록한다.
func (s *Server) AddConnection(connID, key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conns[connID] = &conn{next: map[uint16]uint64{}}
	s.keys[key] = keyState{conn: connID}
}

// IssueKey는 연결에 키를 더 발급한다(키 교체).
func (s *Server) IssueKey(connID, key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.keys[key] = keyState{conn: connID}
}

// RevokeKey는 키를 폐기한다.
func (s *Server) RevokeKey(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := s.keys[key]
	k.revoked = true
	s.keys[key] = k
}

// Archive는 연결을 보관한다.
func (s *Server) Archive(connID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conns[connID].archived = true
}

// Forget은 연결의 순번 기록을 잃은 상황을 만든다.
func (s *Server) Forget(connID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.conns[connID]
	for g := range c.next {
		c.next[g] = 1
	}
}

// InjectFault는 다음 묶음 요청들에 차례로 장애를 끼운다.
func (s *Server) InjectFault(f ...Fault) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.faults = append(s.faults, f...)
}

// SetLimit은 압축을 푼 묶음 크기 상한이다. 넘으면 413이다.
func (s *Server) SetLimit(n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.limitBytes = n
}

// Records는 연결에 저장된 기록을 저장한 순서대로 돌려준다.
func (s *Server) Records(connID string) []Stored {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Stored(nil), s.conns[connID].stored...)
}

// Duplicates는 이미 받은 순번이라 저장하지 않은 기록 수다.
func (s *Server) Duplicates() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.duplicates
}

func (s *Server) handleGenerations(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	connID, code := s.auth(r)
	if code != "" {
		writeError(w, http.StatusUnauthorized, code, 0)
		return
	}
	var body struct {
		Protocol     int    `json:"protocol"`
		ConnectionID string `json:"connection_id"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil || body.Protocol != Protocol {
		writeError(w, http.StatusBadRequest, "protocol_unsupported", 0)
		return
	}
	if body.ConnectionID != connID {
		writeError(w, http.StatusForbidden, "connection_mismatch", 0)
		return
	}
	c := s.conns[connID]
	if c.archived {
		writeError(w, http.StatusForbidden, "connection_archived", 0)
		return
	}
	c.maxGen++
	c.next[c.maxGen] = 1
	writeJSON(w, http.StatusOK, map[string]any{"generation": c.maxGen})
}

func (s *Server) handleBatches(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	connID, code := s.auth(r)
	if code != "" {
		writeError(w, http.StatusUnauthorized, code, 0)
		return
	}
	body, err := readBody(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_batch", 0)
		return
	}
	if s.limitBytes > 0 && len(body) > s.limitBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "batch_too_large", 0)
		return
	}
	var b batch
	if err := json.Unmarshal(body, &b); err != nil {
		writeError(w, http.StatusBadRequest, "bad_batch", 0)
		return
	}
	if b.Protocol != Protocol {
		writeError(w, http.StatusBadRequest, "protocol_unsupported", 0)
		return
	}
	if b.ConnectionID != connID {
		writeError(w, http.StatusForbidden, "connection_mismatch", 0)
		return
	}
	c := s.conns[connID]
	if c.archived {
		writeError(w, http.StatusForbidden, "connection_archived", 0)
		return
	}
	next, ok := c.next[b.Generation]
	if !ok || len(b.Records) == 0 {
		writeError(w, http.StatusBadRequest, "bad_batch", 0)
		return
	}
	for i, rec := range b.Records {
		if rec.Seq != b.Records[0].Seq+uint64(i) {
			writeError(w, http.StatusBadRequest, "bad_batch", 0)
			return
		}
	}
	var fault *Fault
	if len(s.faults) > 0 {
		f := s.faults[0]
		s.faults = s.faults[1:]
		fault = &f
	}
	if fault != nil && !fault.StoreFirst {
		writeFault(w, *fault, next)
		return
	}
	if b.Records[0].Seq > next {
		writeError(w, http.StatusConflict, "seq_gap", next)
		return
	}
	stored, dup := 0, 0
	for _, rec := range b.Records {
		if rec.Seq < next {
			dup++ // 이미 받은 순번은 다시 저장하지 않는다(D06)
			continue
		}
		c.stored = append(c.stored, Stored{Generation: b.Generation, ConfigVersion: b.ConfigVersion, Record: rec})
		next++
		stored++
	}
	c.next[b.Generation] = next
	s.duplicates += dup
	if fault != nil {
		writeFault(w, *fault, next)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"acked_through": next - 1, "generation": b.Generation, "stored": stored, "duplicate": dup,
	})
}

func (s *Server) auth(r *http.Request) (connID, code string) {
	key, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok {
		return "", "key_invalid"
	}
	k, ok := s.keys[key]
	switch {
	case !ok:
		return "", "key_invalid"
	case k.revoked:
		return "", "key_revoked"
	}
	return k.conn, ""
}

func readBody(r *http.Request) ([]byte, error) {
	var rd io.Reader = io.LimitReader(r.Body, 64<<20)
	if r.Header.Get("Content-Encoding") == "gzip" {
		zr, err := gzip.NewReader(rd)
		if err != nil {
			return nil, err
		}
		defer zr.Close()
		rd = io.LimitReader(zr, 64<<20)
	}
	return io.ReadAll(rd)
}

func writeFault(w http.ResponseWriter, f Fault, next uint64) {
	if f.RetryAfter != "" {
		w.Header().Set("Retry-After", f.RetryAfter)
	}
	exp := f.ExpectedSeq
	if exp == 0 && f.Code == "seq_gap" {
		exp = next
	}
	writeError(w, f.Status, f.Code, exp)
}

func writeError(w http.ResponseWriter, status int, code string, expected uint64) {
	body := map[string]any{"code": code, "retryable": status >= 500 || status == http.StatusTooManyRequests, "message": code}
	if expected > 0 {
		body["expected_seq"] = expected
	}
	writeJSON(w, status, body)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
