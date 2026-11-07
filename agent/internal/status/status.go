// Package status는 연결마다 상태 보고를 수신 서버에 보낸다(계약 초안 2.7절).
//
// 상태 보고는 대기에 쌓지 않는 최선 노력 전송이다. 보내지 못한 보고는 다음 보고가 대신하고,
// 중앙은 마지막 보고 시각으로 `관측 오래됨/미확인`을 판정한다. 모르는 값은 0이 아니라 null로
// 보낸다(설계 점검 마지막 항목).
package status

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gus-bms/logdock/agent/internal/collect"
	"github.com/gus-bms/logdock/agent/internal/ship"
	"github.com/gus-bms/logdock/agent/internal/tail"
)

// Options의 기본값은 시제품용이다.
type Options struct {
	URL          string
	ConnectionID string
	KeyPath      string
	InstanceID   string
	AgentVersion string
	Timezone     string
	Client       *http.Client
	Interval     time.Duration // 정기 보고 간격
	MinGap       time.Duration // 상태가 바뀌어 바로 보낼 때도 이보다 자주 보내지 않는다
	Timeout      time.Duration
	Now          func() time.Time
}

// Snapshot은 보고 한 번에 담을 값이다. 실행기가 모아 넘긴다.
type Snapshot struct {
	ConfigVersion   int
	ConfigAppliedAt time.Time
	Read            collect.Status
	Send            ship.Status
	Queue           Queue
	Resources       Resources
	Stopping        bool // 서버 운영자의 정상 중지(Q05-02)
}

// Queue는 대기 상태다. 모르면 nil이다.
type Queue struct {
	Records          uint64
	Bytes            int64
	OldestObservedAt *time.Time
	LimitBytes       int64
}

// Resources는 에이전트 프로세스 전체의 자원이다. 잴 수 없는 값은 nil이다.
type Resources struct {
	CPURatio  *float64
	RSSBytes  *int64
	DiskBytes int64
	OpenFiles *int
}

// Reply는 수신 서버의 응답이다. 에이전트는 이 응답으로 설정을 바꾸지 않는다(원격 설정 없음).
type Reply struct {
	ServerTime      time.Time `json:"server_time"`
	ConnectionState string    `json:"connection_state"`
}

// Reporter는 연결 하나의 상태 보고를 보낸다. 한 고루틴에서만 쓴다.
type Reporter struct {
	opt      Options
	lastSent time.Time
	lastKey  string
}

// New는 Reporter를 만든다.
func New(opt Options) *Reporter {
	if opt.Interval <= 0 {
		opt.Interval = 30 * time.Second
	}
	if opt.MinGap <= 0 {
		opt.MinGap = time.Second
	}
	if opt.Timeout <= 0 {
		opt.Timeout = 10 * time.Second
	}
	if opt.Client == nil {
		opt.Client = http.DefaultClient
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	return &Reporter{opt: opt}
}

// Due는 보낼 때인지 본다. 정기 간격이 지났거나, 상태가 바뀌었고 마지막 보고에서 MinGap이
// 지났으면 참이다(상태가 바뀌면 빈도 제한 안에서 바로 보낸다).
func (r *Reporter) Due(s Snapshot) bool {
	since := r.opt.Now().Sub(r.lastSent)
	if r.lastSent.IsZero() || since >= r.opt.Interval {
		return true
	}
	return stateKey(s) != r.lastKey && since >= r.opt.MinGap
}

func stateKey(s Snapshot) string {
	return fmt.Sprintf("%s/%s|%s/%s|%v|%d", s.Read.State, s.Read.Reason, s.Send.State, s.Send.Reason, s.Stopping, s.ConfigVersion)
}

// Send는 보고 하나를 보낸다. 실패해도 다음 보고가 대신하므로 다시 보내지 않는다.
func (r *Reporter) Send(ctx context.Context, s Snapshot) (Reply, error) {
	now := r.opt.Now()
	r.lastSent, r.lastKey = now, stateKey(s)
	body, err := json.Marshal(r.build(s, now))
	if err != nil {
		return Reply{}, err
	}
	key, err := readKey(r.opt.KeyPath)
	if err != nil {
		return Reply{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, r.opt.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.opt.URL+"/status", bytes.NewReader(body))
	if err != nil {
		return Reply{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := r.opt.Client.Do(req)
	if err != nil {
		return Reply{}, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(b, &e)
		return Reply{}, fmt.Errorf("status report: HTTP %d %s", resp.StatusCode, e.Code)
	}
	var rep Reply
	_ = json.Unmarshal(b, &rep)
	return rep, nil
}

type report struct {
	Protocol     int    `json:"protocol"`
	ConnectionID string `json:"connection_id"`
	Agent        struct {
		InstanceID string    `json:"instance_id"`
		Version    string    `json:"version"`
		Timezone   string    `json:"timezone"`
		SentAt     time.Time `json:"sent_at"`
	} `json:"agent"`
	Config struct {
		Version   int       `json:"version"`
		AppliedAt time.Time `json:"applied_at"`
	} `json:"config"`
	Read struct {
		State      string     `json:"state"`
		Reason     string     `json:"reason,omitempty"`
		LastReadAt *time.Time `json:"last_read_at"`
		Bytes      int64      `json:"bytes"`
	} `json:"read"`
	Queue struct {
		Records          uint64     `json:"records"`
		Bytes            int64      `json:"bytes"`
		OldestObservedAt *time.Time `json:"oldest_observed_at"`
		LimitBytes       int64      `json:"limit_bytes"`
	} `json:"queue"`
	Send struct {
		State        string     `json:"state"`
		Reason       string     `json:"reason,omitempty"`
		AckedThrough uint64     `json:"acked_through"`
		LastAckAt    *time.Time `json:"last_ack_at"`
	} `json:"send"`
	Rejected struct {
		EventTooLarge int64     `json:"event_too_large"`
		Since         time.Time `json:"since"`
		LimitBytes    int       `json:"limit_bytes"`
	} `json:"rejected"`
	Loss      []loss `json:"loss"`
	Resources struct {
		CPURatio  *float64 `json:"cpu_ratio"`
		RSSBytes  *int64   `json:"rss_bytes"`
		DiskBytes int64    `json:"disk_bytes"`
		OpenFiles *int     `json:"open_files"`
	} `json:"resources"`
	DiagWriteError bool `json:"diag_write_error"`
}

// loss는 누락 구간 하나다. 파일은 파일 칸을, journald는 unit과 버린 수를 쓴다.
type loss struct {
	Kind           string    `json:"kind"`
	FileID         string    `json:"file_id,omitempty"`
	Offset         *int64    `json:"offset,omitempty"`
	SkippedBytes   *int64    `json:"skipped_bytes,omitempty"`
	SkippedUnknown bool      `json:"skipped_unknown,omitempty"`
	Unit           string    `json:"unit,omitempty"`
	DroppedEntries *int64    `json:"dropped_entries,omitempty"`
	ObservedAt     time.Time `json:"observed_at"`
}

func (r *Reporter) build(s Snapshot, now time.Time) report {
	var b report
	b.Protocol = ship.Protocol
	b.ConnectionID = r.opt.ConnectionID
	b.Agent.InstanceID, b.Agent.Version, b.Agent.Timezone, b.Agent.SentAt = r.opt.InstanceID, r.opt.AgentVersion, r.opt.Timezone, utc(now)
	b.Config.Version, b.Config.AppliedAt = s.ConfigVersion, utc(s.ConfigAppliedAt)

	b.Read.State, b.Read.Reason = string(s.Read.State), s.Read.Reason
	if s.Stopping {
		b.Read.State, b.Read.Reason = "stopping", "operator_stop"
	}
	b.Read.LastReadAt, b.Read.Bytes = optTime(s.Read.LastReadAt), s.Read.ReadBytes

	b.Queue.Records, b.Queue.Bytes, b.Queue.OldestObservedAt, b.Queue.LimitBytes =
		s.Queue.Records, s.Queue.Bytes, s.Queue.OldestObservedAt, s.Queue.LimitBytes

	b.Send.State, b.Send.Reason = string(s.Send.State), s.Send.Reason
	b.Send.AckedThrough, b.Send.LastAckAt = s.Send.AckedThrough, optTime(s.Send.LastAckAt)

	b.Rejected.EventTooLarge, b.Rejected.Since, b.Rejected.LimitBytes = s.Read.Rejected, utc(s.Read.RejectedSince), s.Read.RejectedLimit

	b.Loss = []loss{}
	for _, l := range s.Read.Loss {
		if l.Journal {
			e := loss{Kind: l.Kind, Unit: l.Unit, ObservedAt: utc(l.ObservedAt), SkippedUnknown: l.ShareUnknown || l.Dropped < 0}
			if l.Dropped >= 0 {
				n := l.Dropped
				e.DroppedEntries = &n
			}
			b.Loss = append(b.Loss, e)
			continue
		}
		off := l.Offset
		e := loss{Kind: l.Kind, FileID: l.FileID, Offset: &off, ObservedAt: utc(l.ObservedAt)}
		if l.SkippedBytes == tail.Unknown {
			e.SkippedUnknown = true
		} else {
			n := l.SkippedBytes
			e.SkippedBytes = &n
		}
		b.Loss = append(b.Loss, e)
	}
	b.Resources.CPURatio, b.Resources.RSSBytes, b.Resources.DiskBytes, b.Resources.OpenFiles =
		s.Resources.CPURatio, s.Resources.RSSBytes, s.Resources.DiskBytes, s.Resources.OpenFiles
	return b
}

func utc(t time.Time) time.Time { return t.UTC().Truncate(time.Microsecond) }

// optTime은 0 시각(아직 없음)을 null로 보낸다.
func optTime(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	u := utc(t)
	return &u
}

func readKey(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}
