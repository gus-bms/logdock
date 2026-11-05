// Package ship은 디스크 대기의 기록을 묶음으로 수신 서버에 보낸다(계약 초안 2.3~2.5절).
//
// 수신 서버가 저장을 끝냈다고 답한 순번(acked_through)까지만 대기에서 지운다(Q04). 응답이
// 없거나 거부돼도 대기는 지우지 않는다(D01). 같은 순번은 같은 내용으로 다시 보내고, 수신
// 서버가 순번으로 중복을 거른다(D06).
//
// 시제품은 연결마다 묶음 하나를 보내고 응답을 받은 뒤 다음 묶음을 보낸다(전송 창 1).
// 계약은 응답 전에도 여러 묶음을 보낼 수 있게 했지만, 측정(M3) 전에는 가장 단순한 형태로 둔다.
package ship

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gus-bms/logdock/agent/internal/queue"
	"github.com/gus-bms/logdock/agent/internal/record"
)

// Protocol은 이 에이전트가 쓰는 규약 버전이다.
const Protocol = 1

// SendState와 사유는 계약 초안 2.7절 상태 보고의 send.state 값이다.
type SendState string

const (
	OK       SendState = "ok"
	Retrying SendState = "retrying"
	Held     SendState = "held"
)

// 보류 사유. 사람이 키·설정·연결을 고쳐야 풀린다(계약 2.4절 표).
var holdCodes = map[string]bool{
	"protocol_unsupported": true, "bad_batch": true, "key_invalid": true, "key_revoked": true,
	"connection_mismatch": true, "connection_archived": true, "duplicate_target": true, "instance_conflict": true,
}

// ReasonQueueCorrupt는 대기를 읽을 수 없다는 뜻이다. 지우지 않고 보류한다. 계약 2.7절 표에 없는 값이다.
const ReasonQueueCorrupt = "queue_corrupt"

// Status는 보내기 상태다. 상태 보고가 이 값을 보낸다.
type Status struct {
	State        SendState
	Reason       string
	AckedThrough uint64
	LastAckAt    time.Time
}

// Options의 기본값은 시제품용이다.
type Options struct {
	URL             string // 예: https://logdock.example.com:8443/ingest/v1
	ConnectionID    string
	KeyPath         string // 키 파일. 보류 중 내용이 바뀌면 바로 다시 보낸다(새 키 적용)
	InstanceID      string
	AgentVersion    string
	Timezone        string // 에이전트 서버 시간대(IANA 이름)
	MaxBatchBytes   int    // 압축 전 기록 본문 합계
	MaxBatchRecords int
	Client          *http.Client
	Timeout         time.Duration // 요청 하나의 제한 시간
	BackoffMin      time.Duration
	BackoffMax      time.Duration
	HoldRetry       time.Duration // 보류 중 다시 해 보는 간격
	Now             func() time.Time
	Jitter          func() float64 // 0~1. 재시도 시각을 흩뜨린다. 시험에서 고정한다
}

func (o *Options) setDefaults() {
	if o.MaxBatchBytes <= 0 {
		o.MaxBatchBytes = 1 << 20
	}
	if o.MaxBatchRecords <= 0 {
		o.MaxBatchRecords = 1000
	}
	if o.Client == nil {
		o.Client = http.DefaultClient
	}
	if o.Timeout <= 0 {
		o.Timeout = 30 * time.Second
	}
	if o.BackoffMin <= 0 {
		o.BackoffMin = time.Second
	}
	if o.BackoffMax <= 0 {
		o.BackoffMax = time.Minute
	}
	if o.HoldRetry <= 0 {
		o.HoldRetry = time.Minute
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Jitter == nil {
		o.Jitter = defaultJitter
	}
}

// Sender는 대기 하나(연결 하나·세대 하나)를 보낸다. 한 고루틴에서만 쓴다.
type Sender struct {
	opt       Options
	q         *queue.Queue
	status    Status
	waitUntil time.Time
	failures  int
	heldKey   [sha256.Size]byte // 키 때문에 보류할 때의 키. 파일이 바뀌면 바로 다시 보낸다
	keyHeld   bool
	maxRecs   int // 413을 받으면 줄인다
}

// New는 Sender를 만든다.
func New(q *queue.Queue, opt Options) *Sender {
	opt.setDefaults()
	return &Sender{opt: opt, q: q, maxRecs: opt.MaxBatchRecords,
		status: Status{State: OK, AckedThrough: q.AckedThrough()}}
}

// Status는 마지막 Step 뒤의 보내기 상태다.
func (s *Sender) Status() Status { return s.status }

// Step은 보낼 차례면 묶음 하나를 보내고 응답을 처리한다. 대기가 비었거나 재시도 시각 전이면
// 아무것도 하지 않는다. 주기적으로 부른다.
func (s *Sender) Step(ctx context.Context) Status {
	now := s.opt.Now()
	if now.Before(s.waitUntil) && !(s.keyHeld && s.keyChanged()) {
		return s.status
	}
	key, err := s.readKey()
	if err != nil {
		return s.hold("key_invalid", nil)
	}
	if s.q.Generation() == 0 {
		if st, done := s.allocateGeneration(ctx, key); !done {
			return st
		}
	}
	from := s.q.AckedThrough() + 1
	if from >= s.q.NextSeq() {
		return s.status // 보낼 것이 없다
	}
	entries, err := s.q.Read(from, s.opt.MaxBatchBytes, s.maxRecs)
	if err != nil {
		return s.hold(ReasonQueueCorrupt, nil)
	}
	body, last, err := s.buildBatch(entries)
	if err != nil {
		return s.hold(ReasonQueueCorrupt, nil)
	}
	res, err := s.post(ctx, "/batches", key, body, true)
	if err != nil {
		return s.retry(netReason(err))
	}
	if res.status != http.StatusOK {
		return s.onError(res, key, len(entries), from)
	}
	var ack struct {
		AckedThrough uint64 `json:"acked_through"`
		Generation   uint16 `json:"generation"`
	}
	if err := json.Unmarshal(res.body, &ack); err != nil || ack.Generation != s.q.Generation() ||
		ack.AckedThrough+1 < from || ack.AckedThrough > last {
		// 보낸 범위 밖을 받았다고 하면 믿을 수 없다. 지우지 않고 사람이 보게 한다.
		return s.hold("bad_batch", nil)
	}
	if ack.AckedThrough >= from {
		if err := s.q.Ack(ack.AckedThrough); err != nil {
			return s.hold(ReasonQueueCorrupt, nil)
		}
	}
	return s.ok(now)
}

// allocateGeneration은 수신 서버에서 새 세대 번호를 받는다. 에이전트는 상태를 잃으면
// 마지막 세대를 모르므로 번호를 스스로 정하지 않는다. 같은 번호로 다시 보내면 수신 서버가
// 이미 받은 순번으로 보고 버리기 때문이다.
func (s *Sender) allocateGeneration(ctx context.Context, key string) (Status, bool) {
	body, err := json.Marshal(map[string]any{
		"protocol": Protocol, "connection_id": s.opt.ConnectionID, "agent": s.agentInfo(),
	})
	if err != nil {
		return s.hold("bad_batch", nil), false
	}
	res, err := s.post(ctx, "/generations", key, body, false)
	if err != nil {
		return s.retry(netReason(err)), false
	}
	if res.status != http.StatusOK {
		return s.onError(res, key, 0, 0), false
	}
	var g struct {
		Generation uint16 `json:"generation"`
	}
	if err := json.Unmarshal(res.body, &g); err != nil || g.Generation == 0 {
		return s.retry("server_error"), false
	}
	if err := s.q.SetGeneration(g.Generation); err != nil {
		return s.hold(ReasonQueueCorrupt, nil), false
	}
	return s.status, true
}

type agentInfo struct {
	InstanceID string `json:"instance_id"`
	Version    string `json:"version"`
	Timezone   string `json:"timezone"`
}

func (s *Sender) agentInfo() agentInfo {
	return agentInfo{InstanceID: s.opt.InstanceID, Version: s.opt.AgentVersion, Timezone: s.opt.Timezone}
}

// buildBatch는 기록을 묶음으로 만든다. 설정 버전이 바뀌는 곳에서 끊는다. 수신 서버는 묶음의
// 설정 버전으로 기록을 해석하기 때문이다(계약 2.3절, AT-09).
func (s *Sender) buildBatch(entries []queue.Entry) ([]byte, uint64, error) {
	var recs []record.Wire
	version := -1
	var last uint64
	for _, e := range entries {
		st, err := record.Decode(e.Payload)
		if err != nil {
			return nil, 0, err
		}
		if version == -1 {
			version = st.ConfigVersion
		} else if st.ConfigVersion != version {
			break
		}
		w := st.Wire
		w.Seq = e.Seq
		recs = append(recs, w)
		last = e.Seq
	}
	b, err := json.Marshal(struct {
		Protocol      int           `json:"protocol"`
		ConnectionID  string        `json:"connection_id"`
		Generation    uint16        `json:"generation"`
		Agent         agentInfo     `json:"agent"`
		ConfigVersion int           `json:"config_version"`
		Records       []record.Wire `json:"records"`
	}{Protocol, s.opt.ConnectionID, s.q.Generation(), s.agentInfo(), version, recs})
	return b, last, err
}

type result struct {
	status int
	body   []byte
	header http.Header
}

// post는 요청 하나를 보낸다. 키는 Authorization 헤더로만 보내고 주소·본문·로그에 넣지 않는다(SC-02).
func (s *Sender) post(ctx context.Context, path, key string, body []byte, gz bool) (result, error) {
	ctx, cancel := context.WithTimeout(ctx, s.opt.Timeout)
	defer cancel()
	if gz {
		var buf bytes.Buffer
		zw := gzip.NewWriter(&buf)
		if _, err := zw.Write(body); err != nil {
			return result{}, err
		}
		if err := zw.Close(); err != nil {
			return result{}, err
		}
		body = buf.Bytes()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.opt.URL+path, bytes.NewReader(body))
	if err != nil {
		return result{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	if gz {
		req.Header.Set("Content-Encoding", "gzip")
	}
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := s.opt.Client.Do(req)
	if err != nil {
		return result{}, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return result{}, err
	}
	return result{status: resp.StatusCode, body: b, header: resp.Header}, nil
}

// onError는 계약 2.4절 표대로 오류 응답을 처리한다.
func (s *Sender) onError(res result, key string, n int, from uint64) Status {
	var e struct {
		Code        string `json:"code"`
		ExpectedSeq uint64 `json:"expected_seq"`
	}
	_ = json.Unmarshal(res.body, &e)
	switch {
	case res.status == http.StatusConflict && e.Code == "seq_gap":
		return s.onSeqGap(e.ExpectedSeq, from)
	case res.status == http.StatusRequestEntityTooLarge:
		if n <= 1 {
			// 이벤트 하나가 수신 상한을 넘는다. 이벤트는 나누지 않으므로(D03) 설정을 봐야 한다.
			return s.hold("bad_batch", nil)
		}
		s.maxRecs = max(1, n/2)
		s.waitUntil = time.Time{}
		return s.status
	case res.status == http.StatusTooManyRequests:
		return s.retryAfter(res.header.Get("Retry-After"), "server_busy")
	case res.status == http.StatusServiceUnavailable:
		return s.retry("storage_unavailable")
	case res.status >= 500:
		return s.retry("server_error")
	case holdCodes[e.Code]:
		var k *string
		if e.Code == "key_invalid" || e.Code == "key_revoked" || e.Code == "connection_archived" {
			k = &key // 재활성도 새 키를 받아야 풀리므로 키가 바뀌면 바로 다시 보낸다
		}
		return s.hold(e.Code, k)
	default:
		return s.hold("bad_batch", nil) // 모르는 거부를 빠르게 되풀이하지 않는다
	}
}

// onSeqGap은 수신 서버가 다른 순번을 기다린다고 답했을 때다.
func (s *Sender) onSeqGap(expected, from uint64) Status {
	switch {
	case expected > from && expected <= s.q.NextSeq():
		// 수신 서버가 expected-1까지 이미 갖고 있다(앞선 응답을 잃은 경우). 거기까지 지운다.
		if err := s.q.Ack(expected - 1); err != nil {
			return s.hold(ReasonQueueCorrupt, nil)
		}
		return s.ok(s.opt.Now())
	case expected < from:
		// 이미 받았다고 확인하고 지운 순번을 다시 달라고 한다. 다시 보낼 수 없으므로 사람이 봐야 한다.
		return s.hold("bad_batch", nil)
	default:
		return s.retry("server_error")
	}
}

func (s *Sender) ok(now time.Time) Status {
	s.failures, s.waitUntil, s.keyHeld = 0, time.Time{}, false
	s.status = Status{State: OK, AckedThrough: s.q.AckedThrough(), LastAckAt: now}
	return s.status
}

// retry는 지수 백오프와 지터로 다음 시도 시각을 정한다. 오래 실패해도 대기를 지우지 않는다(D01).
func (s *Sender) retry(reason string) Status {
	s.failures++
	d := s.opt.BackoffMin << min(s.failures-1, 20)
	if d <= 0 || d > s.opt.BackoffMax {
		d = s.opt.BackoffMax
	}
	d = time.Duration(float64(d) * (0.8 + 0.4*s.opt.Jitter())) // ±20%
	return s.wait(d, Retrying, reason)
}

func (s *Sender) retryAfter(v, reason string) Status {
	sec, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || sec < 0 {
		return s.retry(reason)
	}
	s.failures++
	return s.wait(min(time.Duration(sec)*time.Second, s.opt.BackoffMax), Retrying, reason)
}

// hold는 사람이 고쳐야 풀리는 오류로 보류한다. 키 때문이면 그 키를 기억해 두고, 키 파일이
// 바뀌면 기다리지 않고 바로 다시 보낸다(새 키로 같은 순번부터, Q10-11).
func (s *Sender) hold(reason string, key *string) Status {
	s.keyHeld = key != nil
	if key != nil {
		s.heldKey = sha256.Sum256([]byte(*key))
	}
	return s.wait(s.opt.HoldRetry, Held, reason)
}

func (s *Sender) wait(d time.Duration, state SendState, reason string) Status {
	s.waitUntil = s.opt.Now().Add(d)
	s.status.State, s.status.Reason = state, reason
	return s.status
}

func (s *Sender) keyChanged() bool {
	key, err := s.readKey()
	return err == nil && sha256.Sum256([]byte(key)) != s.heldKey
}

// readKey는 키 파일을 읽는다. 키를 오류 메시지나 로그에 넣지 않는다.
func (s *Sender) readKey() (string, error) {
	b, err := os.ReadFile(s.opt.KeyPath)
	if err != nil {
		return "", err
	}
	key := strings.TrimSpace(string(b))
	if !strings.HasPrefix(key, "ldk_") {
		return "", errors.New("ship: key file does not hold a LogDock key")
	}
	return key, nil
}

// netReason은 연결 오류를 계약 2.7절의 send 사유로 나눈다.
func netReason(err error) string {
	var ne net.Error
	var dnsErr *net.DNSError
	var certErr *tls.CertificateVerificationError
	var recErr tls.RecordHeaderError
	switch {
	case errors.As(err, &dnsErr):
		return "dns_error"
	case errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()):
		return "timeout"
	case errors.As(err, &certErr) || errors.As(err, &recErr):
		return "tls_error"
	default:
		return "server_error"
	}
}

func defaultJitter() float64 {
	return float64(time.Now().UnixNano()%1000) / 1000
}

// String은 디버깅용이다. 키를 담지 않는다.
func (st Status) String() string {
	return fmt.Sprintf("%s(%s) acked %d", st.State, st.Reason, st.AckedThrough)
}
