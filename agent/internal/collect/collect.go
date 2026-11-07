// Package collect는 연결 하나의 읽기 흐름이다. 파일을 따라 읽어(tail) 이벤트로 묶고
// (assemble) 디스크 대기(queue)에 순번과 함께 확정한다.
//
// 읽은 위치는 기록마다 함께 대기에 넣는다. 그래서 대기에 확정된 기록까지만 읽은 것으로 치고,
// 재시작하면 마지막으로 확정된 기록 다음부터 다시 읽는다(AG-12). 파일 하나는 Reader, 파일명
// 규칙은 PatternReader가 읽는다. PatternReader는 파일이 여럿이라 모든 파일의 위치를 스냅샷으로
// 함께 확정한다(pattern.go).
package collect

import (
	"errors"
	"io/fs"
	"time"

	"github.com/gus-bms/logdock/agent/internal/assemble"
	"github.com/gus-bms/logdock/agent/internal/queue"
	"github.com/gus-bms/logdock/agent/internal/record"
	"github.com/gus-bms/logdock/agent/internal/tail"
)

// ReadState와 사유는 계약 초안 2.7절 상태 보고의 read.state 값이다.
type ReadState string

const (
	Running ReadState = "running"
	Paused  ReadState = "paused"
	Held    ReadState = "held"
	Failed  ReadState = "failed"
)

const (
	ReasonQueueFull        = "queue_full"
	ReasonDiskUnavailable  = "disk_unavailable"
	ReasonPermissionDenied = "permission_denied"
	ReasonPathMissing      = "path_missing"
	ReasonConfigInvalid    = "config_invalid"
	ReasonRecoveryHold     = "recovery_hold"
	ReasonStateWriteFailed = "state_write_failed"
	// ReasonReadError는 원본을 읽다 난 그 밖의 입출력 오류다. 계약 2.7절 표에 아직 없는 값이다.
	ReasonReadError = "read_error"
	// ReasonFileLimit은 파일명 규칙에 맞는 파일이 한도(따라가는 파일 수, 동시에 여는 파일 수)를
	// 넘어 따라가지 못하거나 아직 읽지 못한 파일이 있다는 뜻이다. 계약 2.7절 표에 아직 없는 값이다.
	ReasonFileLimit = "file_limit"
)

// Status는 읽기 상태다. 상태 보고가 이 값을 보낸다.
type Status struct {
	State      ReadState
	Reason     string
	LastReadAt time.Time
	ReadBytes  int64
	// Rejected는 이 실행에서 크기 상한을 넘어 거부한 이벤트 수다. 중앙은 대기로 받은 거부
	// 기록으로 세고(계약 2.7절), 이 값은 아직 보내지 못한 거부를 보이는 보조 값이다.
	Rejected      int64
	RejectedSince time.Time
	RejectedLimit int
	Loss          []Loss // 최근 누락 의심 구간(최대 maxLoss개)
}

// Loss는 읽지 못하고 지나간 구간 하나다. SkippedBytes가 tail.Unknown이면 크기를 모른다.
type Loss struct {
	Kind         string
	FileID       string
	Offset       int64
	SkippedBytes int64
	ObservedAt   time.Time
	// journald: Journal이 켜져 있으면 파일 칸 대신 아래 칸을 쓴다. Dropped는 journald가 그 unit에서
	// 버린 수(모르면 -1), ShareUnknown은 그 수에서 이 대상의 몫을 모른다는 뜻이다.
	Journal      bool
	Unit         string
	Dropped      int64
	ShareUnknown bool
}

const maxLoss = 16

// Store는 Reader가 쓰는 대기 기능이다. 시험에서 쓰기 실패를 흉내 내려고 인터페이스로 둔다.
type Store interface {
	Append(payloads [][]byte) (uint64, error)
	Last() (queue.Entry, bool, error)
	NextSeq() uint64
	Used() int64
	// Unacked는 수신 확인되지 않은 기록이 든 바이트다. 멈춤·재개 판단에 쓴다(queue.Queue.Unacked).
	Unacked() int64
	Limit() int64
}

// Options의 기본값은 시제품용이다.
type Options struct {
	// Path는 파일 하나(Reader)의 경로이거나 파일명 규칙(PatternReader)이다.
	Path          string
	ConfigVersion int
	Tail          tail.Options
	Assemble      assemble.Options
	// ResumeRatio는 대기가 한도에 닿아 읽기를 멈춘 뒤, 사용량이 한도의 이 비율 아래로
	// 내려가야 다시 읽는다는 뜻이다. 한도 근처에서 멈춤과 재개가 반복되지 않게 한다(D01).
	ResumeRatio float64
	// SnapshotInterval은 PatternReader가 파일별 읽기 위치 스냅샷을 쓰는 최소 간격이다. 길면 쓰기는
	// 줄지만 재시작 때 다시 읽을 기록과 수신 확인 뒤에도 남겨 두는 대기가 늘어난다.
	SnapshotInterval time.Duration
	// Journal은 journald 연결(JournalReader)의 설정이다.
	Journal JournalOptions
}

func (o *Options) setDefaults() {
	if o.ResumeRatio <= 0 || o.ResumeRatio >= 1 {
		o.ResumeRatio = 0.9
	}
	if o.SnapshotInterval <= 0 {
		o.SnapshotInterval = time.Second
	}
}

// base는 두 읽기 흐름(파일 하나, 파일명 규칙)이 함께 쓰는 대기 쓰기와 읽기 상태다.
type base struct {
	opt     Options
	store   Store
	pending [][]byte // 대기에 쓰지 못해 들고 있는 기록. 쓸 때까지 더 읽지 않는다
	status  Status
}

// Reader는 파일 하나를 따라 읽는 연결 하나다(file). 한 고루틴에서만 쓴다.
type Reader struct {
	base
	f    *tail.Follower
	asm  *assemble.Assembler
	hold bool // 복구 보류. 서버 운영자가 다시 수집을 고를 때까지 읽지 않는다(Q06)
}

// NewReader는 대기의 마지막 기록에서 재시작 위치를 되살려 Reader를 만든다. 대기가 비었으면
// 최초 연결로 보고 파일 끝에서 시작한다(D02).
func NewReader(store Store, opt Options) (*Reader, error) {
	opt.setDefaults()
	r := &Reader{
		base: base{opt: opt, store: store},
		f:    tail.New(opt.Path, opt.Tail),
		asm:  assemble.New(opt.Assemble),
	}
	r.status = Status{State: Running, RejectedSince: r.asmNow(), RejectedLimit: opt.Assemble.MaxEventBytes}
	last, ok, err := store.Last()
	if err != nil {
		return nil, err
	}
	if !ok && store.NextSeq() > 1 {
		// 전에 쓴 기록이 있는데 재시작 위치가 사라졌다. 파일 끝부터 새로 시작하면 그 사이
		// 로그를 말없이 건너뛰므로, 읽지 않고 복구 보류로 둔다(D02 복구 상태 유실, Q06).
		r.status = Status{State: Held, Reason: ReasonRecoveryHold}
		r.hold = true
		return r, nil
	}
	if ok {
		s, err := record.Decode(last.Payload)
		if err != nil {
			return nil, err
		}
		pos, cp, err := s.Checkpoint.Position()
		if err != nil {
			return nil, err
		}
		r.f.Restore(pos)
		r.asm.Restore(cp)
	}
	return r, nil
}

// Status는 마지막 Step 뒤의 읽기 상태다.
func (r *Reader) Status() Status { return r.status }

// Close는 열어 둔 원본 파일을 닫는다.
func (r *Reader) Close() error { return r.f.Close() }

// Step은 한 번 읽어 대기에 확정하고 읽기 상태를 돌려준다. 주기적으로 부른다.
func (r *Reader) Step() Status {
	if r.hold {
		return r.status
	}
	if len(r.pending) > 0 {
		if !r.flush() {
			return r.status
		}
	}
	if r.queueFull() {
		// D01: 대기가 가득 찼다. 기존 대기는 그대로 두고 원본 읽기만 멈춘다. 앱은 계속
		// 원본에 쓰므로, 멈춘 사이 원본이 회전·삭제되면 그만큼 놓칠 수 있다(경계로 알린다).
		r.status.State, r.status.Reason = Paused, ReasonQueueFull
		return r.status
	}
	chunks, err := r.f.Poll()
	var recs []assemble.Record
	for _, c := range chunks {
		if c.Data != nil {
			r.status.LastReadAt = r.asmNow()
			r.status.ReadBytes += int64(len(c.Data))
		}
		recs = append(recs, r.asm.Push(c)...)
	}
	recs = append(recs, r.asm.Tick()...)
	for _, rec := range recs {
		b, encErr := record.Encode(rec, r.opt.Path, r.opt.ConfigVersion, r.f.Head)
		if encErr != nil {
			r.status.State, r.status.Reason = Held, ReasonReadError
			return r.status
		}
		r.pending = append(r.pending, b)
		r.note(rec)
	}
	if len(r.pending) > 0 && !r.flush() {
		return r.status
	}
	r.status.State, r.status.Reason = Running, ""
	if err != nil {
		r.status.State, r.status.Reason = Held, readReason(err)
	} else if _, ok := r.f.Position(); !ok {
		r.status.State, r.status.Reason = Held, ReasonPathMissing
	}
	return r.status
}

// flush는 들고 있는 기록을 대기에 쓴다. 실패하면 기록을 버리지 않고 들고 있으며 더 읽지
// 않는다(D05: 디스크를 쓸 수 없으면 자동으로 메모리로 바꾸지 않는다). 그 사이 멈추면
// 읽은 위치도 확정되지 않았으므로 재시작 뒤 같은 곳을 다시 읽는다.
func (r *base) flush() bool {
	if _, err := r.store.Append(r.pending); err != nil {
		r.status.State, r.status.Reason = Failed, ReasonDiskUnavailable
		return false
	}
	r.pending = nil
	return true
}

// note는 상태 보고에 실을 거부 수와 누락 구간을 센다.
func (r *base) note(rec assemble.Record) {
	switch {
	case rec.Kind == assemble.Rejected:
		r.status.Rejected++
	case rec.Kind == assemble.Boundary && isLoss(rec.Chunk.Boundary):
		off := rec.Offset
		if rec.Chunk.Boundary == tail.NewFileTail {
			off = 0 // 건너뛴 구간은 파일 처음부터 발견한 때의 끝까지다
		}
		r.status.Loss = append(r.status.Loss, Loss{Kind: string(rec.Chunk.Boundary), FileID: rec.File.String(),
			Offset: off, SkippedBytes: rec.Chunk.SkippedBytes, ObservedAt: rec.ObservedAt})
		if n := len(r.status.Loss); n > maxLoss {
			r.status.Loss = append([]Loss(nil), r.status.Loss[n-maxLoss:]...)
		}
	}
}

// isLoss는 누락이 생길 수 있는 경계 종류다(계약 2.7절 loss).
func isLoss(k tail.BoundaryKind) bool {
	switch k {
	case tail.GoneBeforeRead, tail.Truncated, tail.IdentityReused, tail.NewFileTail:
		return true
	}
	return false
}

func (r *base) queueFull() bool {
	used, limit := r.store.Unacked(), r.store.Limit()
	if r.status.State == Paused && r.status.Reason == ReasonQueueFull {
		return float64(used) > r.opt.ResumeRatio*float64(limit)
	}
	return used >= limit
}

func (r *base) asmNow() time.Time {
	if r.opt.Assemble.Now != nil {
		return r.opt.Assemble.Now()
	}
	return time.Now()
}

func readReason(err error) string {
	switch {
	case errors.Is(err, fs.ErrPermission):
		return ReasonPermissionDenied
	case errors.Is(err, fs.ErrNotExist):
		return ReasonPathMissing
	case errors.Is(err, tail.ErrNotRegular):
		return ReasonConfigInvalid
	default:
		return ReasonReadError
	}
}
