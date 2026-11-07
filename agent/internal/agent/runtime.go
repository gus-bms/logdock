// Package agent는 에이전트 실행기다. 연결마다 읽기·보내기·상태 보고를 따로 돌린다.
//
// 읽기는 보내기를 기다리지 않는다. 수신 서버가 멈춰도 대기 한도까지 계속 읽어 쌓는다(D01).
// 중지 신호를 받으면 새 읽기·전송을 바로 멈추고 남은 전송이나 응답을 기다리지 않는다
// (Q05-02, Q16-09). 응답을 못 받은 묶음은 대기에 남아 다음 실행에서 같은 순번으로 다시 간다.
package agent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gus-bms/logdock/agent/internal/assemble"
	"github.com/gus-bms/logdock/agent/internal/collect"
	"github.com/gus-bms/logdock/agent/internal/config"
	"github.com/gus-bms/logdock/agent/internal/journal"
	"github.com/gus-bms/logdock/agent/internal/queue"
	"github.com/gus-bms/logdock/agent/internal/record"
	"github.com/gus-bms/logdock/agent/internal/ship"
	"github.com/gus-bms/logdock/agent/internal/status"
)

// Runtime은 에이전트 프로세스 하나다.
type Runtime struct {
	cfg        config.Agent
	version    string
	instanceID string
	timezone   string
	log        *slog.Logger
}

// New는 상태 폴더를 준비하고 인스턴스 ID를 읽거나 만든다.
func New(cfg config.Agent, version string, log *slog.Logger) (*Runtime, error) {
	// 상태 폴더에는 로그 본문이 든 대기가 있으므로 실행 계정만 읽게 둔다.
	if err := os.MkdirAll(cfg.StateDir, 0o700); err != nil {
		return nil, err
	}
	id, err := loadInstanceID(cfg.StateDir)
	if err != nil {
		return nil, err
	}
	return &Runtime{cfg: cfg, version: version, instanceID: id, timezone: systemTimezone(), log: log}, nil
}

// InstanceID는 이 에이전트의 인스턴스 ID다. 인증 근거가 아니다(계약 2.2절).
func (rt *Runtime) InstanceID() string { return rt.instanceID }

// Run은 연결을 모두 돌리고 ctx가 끝나면 멈춘다. 잘못된 연결은 건너뛰고 나머지는 돌린다.
func (rt *Runtime) Run(ctx context.Context) error {
	conns, errs := config.LoadConnections(rt.cfg.ConnectionsDir)
	for file, err := range errs {
		rt.log.Error("connection config rejected", "file", filepath.Base(file), "error", err)
	}
	if len(conns) == 0 {
		rt.log.Warn("no connection to collect", "dir", rt.cfg.ConnectionsDir)
	}
	var wg sync.WaitGroup
	for _, c := range conns {
		w, err := rt.newWorker(c)
		if err != nil {
			rt.log.Error("connection not started", "connection", c.ID, "error", err)
			rt.writeLocal(localStatus{ConnectionID: c.ID, UpdatedAt: time.Now().UTC(), Error: err.Error()})
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			w.run(ctx)
		}()
	}
	<-ctx.Done()
	wg.Wait()
	return nil
}

// source는 연결 하나의 읽기 흐름이다. 파일 하나는 collect.Reader, 파일명 규칙은
// collect.PatternReader다.
type source interface {
	Step() collect.Status
	Status() collect.Status
	Close() error
}

// worker는 연결 하나다.
type worker struct {
	rt      *Runtime
	c       config.Connection
	q       *queue.Queue
	reader  source
	sender  *ship.Sender
	rep     *status.Reporter
	applied time.Time
	cpu     sampler

	mu     sync.Mutex
	readSt collect.Status
	sendSt ship.Status
}

func (rt *Runtime) newWorker(c config.Connection) (*worker, error) {
	if err := c.CheckAgainst(rt.cfg); err != nil {
		return nil, err
	}
	if err := config.CheckKeyFile(c.KeyPath); err != nil {
		return nil, err
	}
	client, err := c.HTTPClient()
	if err != nil {
		return nil, err
	}
	// 파일명 규칙은 파일별 읽기 위치를 스냅샷으로 따로 확정하므로 대기가 스냅샷 뒤 기록을 남긴다.
	pattern := c.Target.Type == "file_pattern"
	// 세대마다 대기 폴더를 둔다. Q06 다시 수집으로 새 세대를 열 때 q-0002를 더한다(다음 단계).
	q, err := queue.Open(filepath.Join(rt.cfg.StateDir, "queue", c.ID, "q-0001"),
		queue.Options{LimitBytes: rt.cfg.QueueLimitBytes, Snapshots: pattern})
	if err != nil {
		return nil, fmt.Errorf("queue: %w", err)
	}
	opt := collect.Options{
		Path: c.Target.Path, ConfigVersion: c.ConfigVersion,
		Assemble: assemble.Options{Format: assemble.Format(c.Format.Type), StartPattern: c.Format.EventStart, MaxEventBytes: c.Format.MaxEventBytes},
	}
	var reader source
	switch c.Target.Type {
	case "file_pattern":
		reader, err = collect.NewPatternReader(q, opt)
	case "journald":
		opt.Journal = collect.JournalOptions{Target: journal.Target{Kind: c.Target.Kind, Name: c.Target.Name}}
		reader, err = collect.NewJournalReader(q, opt)
	default:
		reader, err = collect.NewReader(q, opt)
	}
	if err != nil {
		q.Close()
		return nil, fmt.Errorf("restart position: %w", err)
	}
	applied, err := rt.configApplied(c)
	if err != nil {
		reader.Close()
		q.Close()
		return nil, err
	}
	w := &worker{rt: rt, c: c, q: q, reader: reader, applied: applied}
	w.sender = ship.New(q, ship.Options{
		URL: c.IngestURL, ConnectionID: c.ID, KeyPath: c.KeyPath, InstanceID: rt.instanceID,
		AgentVersion: rt.version, Timezone: rt.timezone, Client: client,
	})
	w.rep = status.New(status.Options{
		URL: c.IngestURL, ConnectionID: c.ID, KeyPath: c.KeyPath, InstanceID: rt.instanceID,
		AgentVersion: rt.version, Timezone: rt.timezone, Client: client, Interval: rt.cfg.StatusInterval,
	})
	w.readSt, w.sendSt = reader.Status(), w.sender.Status()
	return w, nil
}

func (w *worker) run(ctx context.Context) {
	var wg sync.WaitGroup
	for _, loop := range []func(context.Context){w.readLoop, w.sendLoop, w.statusLoop} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			loop(ctx)
		}()
	}
	wg.Wait()

	// 정상 중지: 보낼 수 있으면 마지막 보고에 중지를 싣되, 1초 넘게 기다리지 않는다(Q05-02).
	snap := w.snapshot()
	snap.Stopping = true
	stopCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	if _, err := w.rep.Send(stopCtx, snap); err != nil {
		w.rt.log.Info("final status report not sent", "connection", w.c.ID, "error", err)
	}
	cancel()
	w.writeLocal(snap)
	w.reader.Close()
	w.q.Close()
}

func (w *worker) readLoop(ctx context.Context) {
	t := time.NewTicker(w.rt.cfg.PollInterval)
	defer t.Stop()
	for {
		st := w.reader.Step()
		w.mu.Lock()
		w.readSt = st
		w.mu.Unlock()
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (w *worker) sendLoop(ctx context.Context) {
	for {
		before := w.q.AckedThrough()
		st := w.sender.Step(ctx)
		w.mu.Lock()
		w.sendSt = st
		w.mu.Unlock()
		if ctx.Err() != nil {
			return
		}
		// 방금 보냈고 더 보낼 것이 있으면 쉬지 않고 이어 보낸다.
		if st.State == ship.OK && w.q.AckedThrough() > before && w.q.AckedThrough() < w.q.NextSeq()-1 {
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(w.rt.cfg.PollInterval):
		}
	}
}

func (w *worker) statusLoop(ctx context.Context) {
	t := time.NewTicker(min(w.rt.cfg.PollInterval, time.Second))
	defer t.Stop()
	var lastLocal time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		snap := w.snapshot()
		if w.rep.Due(snap) {
			if _, err := w.rep.Send(ctx, snap); err != nil && ctx.Err() == nil {
				w.rt.log.Warn("status report failed", "connection", w.c.ID, "error", err)
			}
		}
		if time.Since(lastLocal) >= 5*time.Second {
			w.writeLocal(snap)
			lastLocal = time.Now()
		}
	}
}

// snapshot은 상태 보고에 담을 값을 모은다.
func (w *worker) snapshot() status.Snapshot {
	w.mu.Lock()
	read, send := w.readSt, w.sendSt
	w.mu.Unlock()
	acked, next := w.q.AckedThrough(), w.q.NextSeq()
	qs := status.Queue{Bytes: w.q.Used(), LimitBytes: w.q.Limit()}
	if next-1 > acked {
		qs.Records = next - 1 - acked
		if es, err := w.q.Read(acked+1, 1, 1); err == nil && len(es) == 1 {
			if s, err := record.Decode(es[0].Payload); err == nil {
				t := s.ObservedAt
				qs.OldestObservedAt = &t
			}
		}
	}
	now := time.Now()
	return status.Snapshot{
		ConfigVersion: w.c.ConfigVersion, ConfigAppliedAt: w.applied, Read: read, Send: send, Queue: qs,
		Resources: status.Resources{CPURatio: w.cpu.cpuRatio(now), RSSBytes: rssBytes(), DiskBytes: w.q.Used(), OpenFiles: openFiles()},
	}
}

// localStatus는 `logdock-agent status`가 읽는 로컬 상태 파일이다. 키와 로그 본문을 담지 않는다.
type localStatus struct {
	ConnectionID string    `json:"connection_id"`
	UpdatedAt    time.Time `json:"updated_at"`
	Error        string    `json:"error,omitempty"` // 연결을 시작하지 못한 이유
	ReadState    string    `json:"read_state,omitempty"`
	ReadReason   string    `json:"read_reason,omitempty"`
	SendState    string    `json:"send_state,omitempty"`
	SendReason   string    `json:"send_reason,omitempty"`
	AckedThrough uint64    `json:"acked_through"`
	QueueRecords uint64    `json:"queue_records"`
	QueueBytes   int64     `json:"queue_bytes"`
	Stopped      bool      `json:"stopped,omitempty"`
}

func (w *worker) writeLocal(s status.Snapshot) {
	w.rt.writeLocal(localStatus{
		ConnectionID: w.c.ID, UpdatedAt: time.Now().UTC(),
		ReadState: string(s.Read.State), ReadReason: s.Read.Reason, SendState: string(s.Send.State), SendReason: s.Send.Reason,
		AckedThrough: s.Send.AckedThrough, QueueRecords: s.Queue.Records, QueueBytes: s.Queue.Bytes, Stopped: s.Stopping,
	})
}

func (rt *Runtime) writeLocal(ls localStatus) {
	dir := filepath.Join(rt.cfg.StateDir, "status")
	b, err := json.MarshalIndent(ls, "", "  ")
	if err == nil {
		err = writeAtomic(dir, ls.ConnectionID+".json", b)
	}
	if err != nil {
		rt.log.Warn("local status not written", "connection", ls.ConnectionID, "error", err)
	}
}

// LocalStatusDir은 로컬 상태 파일이 있는 폴더다.
func LocalStatusDir(cfg config.Agent) string { return filepath.Join(cfg.StateDir, "status") }

// configApplied는 이 설정 버전을 처음 적용한 시각이다. 재시작해도 바뀌지 않게 저장한다.
// 상태 보고의 config.applied_at으로 중앙이 `에이전트 적용 확인`을 판정한다(UI-11 7단계).
func (rt *Runtime) configApplied(c config.Connection) (time.Time, error) {
	dir := filepath.Join(rt.cfg.StateDir, "applied")
	var saved struct {
		Version   int       `json:"version"`
		AppliedAt time.Time `json:"applied_at"`
	}
	b, err := os.ReadFile(filepath.Join(dir, c.ID+".json"))
	if err == nil && json.Unmarshal(b, &saved) == nil && saved.Version == c.ConfigVersion {
		return saved.AppliedAt, nil
	}
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return time.Time{}, err
	}
	saved.Version, saved.AppliedAt = c.ConfigVersion, time.Now().UTC()
	b, err = json.Marshal(saved)
	if err != nil {
		return time.Time{}, err
	}
	return saved.AppliedAt, writeAtomic(dir, c.ID+".json", b)
}

var instanceIDPattern = regexp.MustCompile(`^a_[0-9a-f]{32}$`)

// loadInstanceID는 처음 실행할 때 만든 무작위 인스턴스 ID를 읽는다(계약 2.2절).
func loadInstanceID(stateDir string) (string, error) {
	path := filepath.Join(stateDir, "instance_id")
	b, err := os.ReadFile(path)
	if err == nil {
		if id := strings.TrimSpace(string(b)); instanceIDPattern.MatchString(id) {
			return id, nil
		}
		return "", fmt.Errorf("%s does not hold an instance id", path)
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	id := "a_" + hex.EncodeToString(raw)
	return id, writeAtomic(stateDir, "instance_id", []byte(id+"\n"))
}

// writeAtomic은 임시 파일에 쓰고 이름을 바꿔, 읽는 쪽이 반쯤 쓴 파일을 보지 않게 한다.
func writeAtomic(dir, name string, b []byte) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, name+".tmp-*")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), filepath.Join(dir, name))
}
