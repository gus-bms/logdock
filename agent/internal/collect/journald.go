package collect

import (
	"errors"
	"fmt"
	"io/fs"
	"os/exec"
	"time"

	"github.com/gus-bms/logdock/agent/internal/assemble"
	"github.com/gus-bms/logdock/agent/internal/journal"
	"github.com/gus-bms/logdock/agent/internal/record"
)

// JournalOptions는 journald 연결의 설정이다.
type JournalOptions struct {
	Target journal.Target
	// Start는 journalctl을 띄운다. nil이면 PATH의 journalctl을 쓴다.
	Start journal.Starter
	// Dirs는 읽기 권한을 확인할 journal 폴더다. nil이면 journal.DefaultDirs다.
	Dirs []string
	// RetryWait는 journalctl이 끝났거나 띄우지 못했을 때 다시 띄우기 전 처음 기다리는 시간이다.
	// 실패가 이어지면 두 배씩 늘려 MaxRetryWait까지 기다린다.
	RetryWait, MaxRetryWait time.Duration
	// Batch와 BatchBytes는 Step 한 번에 처리하는 항목 수와 본문 바이트의 상한이다. 한 번에 대기에
	// 쓰는 양을 묶어 메모리와 세그먼트 하나의 크기를 제한한다.
	Batch      int
	BatchBytes int
	// Buffer는 journalctl 출력에서 읽어 두는 항목 수다. 차면 journalctl이 출력에서 멈춘다.
	Buffer int
}

func (o *JournalOptions) setDefaults() {
	if o.Start == nil {
		o.Start = journal.ExecStarter("journalctl", nil)
	}
	if o.Dirs == nil {
		o.Dirs = journal.DefaultDirs
	}
	if o.RetryWait <= 0 {
		o.RetryWait = time.Second
	}
	if o.MaxRetryWait <= 0 {
		o.MaxRetryWait = 30 * time.Second
	}
	if o.Batch <= 0 {
		o.Batch = 4096
	}
	if o.BatchBytes <= 0 {
		o.BatchBytes = 1 << 20
	}
	if o.Buffer <= 0 {
		o.Buffer = 1024
	}
}

// JournalReader는 journald 대상 하나를 읽는 연결이다(journald). 한 고루틴에서만 쓴다.
//
// 읽은 위치는 파일 Reader처럼 기록마다 함께 대기에 확정한다(journal.Position). 대기가 가득 차면
// journalctl을 끝내고, 자리가 나면 마지막으로 확정한 위치에서 다시 띄운다. 멈춘 채 journalctl을
// 붙잡아 두면 journald가 지운 journal 파일을 계속 열어 두어 디스크를 돌려주지 못하기 때문이다.
// 다시 띄울 때마다 저장한 항목이 아직 있는지 먼저 확인하고, 없으면 그 사이를 건너뛰지 않고
// 복구 보류로 둔다(D02).
type JournalReader struct {
	base
	jo   JournalOptions
	popt journal.Options

	pipe      *journal.Pipeline
	run       *journal.Run
	resume    *journal.Position // 대기에 확정한 마지막 기록 뒤 위치. nil이면 최초 연결
	lastAfter *journal.Position // 들고 있는 기록 가운데 마지막 기록 뒤 위치
	verify    string            // 다시 띄운 직후 첫 항목이 이 Ident여야 한다
	hold      bool
	retryAt   time.Time
	wait      time.Duration
	lastErr   error
}

// NewJournalReader는 대기의 마지막 기록에서 재시작 위치를 되살려 JournalReader를 만든다. 대기가
// 비었으면 최초 연결로 보고 journal의 마지막 항목 뒤부터 시작한다(D02).
func NewJournalReader(store Store, opt Options) (*JournalReader, error) {
	opt.setDefaults()
	opt.Journal.setDefaults()
	a := opt.Assemble
	r := &JournalReader{
		base: base{opt: opt, store: store},
		jo:   opt.Journal,
		popt: journal.Options{Target: opt.Journal.Target, Format: a.Format, StartPattern: a.StartPattern,
			MaxEventBytes: a.MaxEventBytes, MaxWait: a.MaxWait, Now: a.Now},
	}
	r.status = Status{State: Running, RejectedSince: r.asmNow(), RejectedLimit: a.MaxEventBytes}
	last, ok, err := store.Last()
	if err != nil {
		return nil, err
	}
	if !ok && store.NextSeq() > 1 {
		r.status = Status{State: Held, Reason: ReasonRecoveryHold}
		r.hold = true
		return r, nil
	}
	if ok {
		s, err := record.Decode(last.Payload)
		if err != nil {
			return nil, err
		}
		if s.Stream.Type != "journald" {
			return nil, fmt.Errorf("queue holds %s records, not journald", s.Stream.Type)
		}
		pos := s.Checkpoint.JournalPosition()
		r.resume = &pos
	}
	return r, nil
}

// Status는 마지막 Step 뒤의 읽기 상태다.
func (r *JournalReader) Status() Status { return r.status }

// Err는 마지막으로 journalctl을 띄우거나 읽다 난 오류다. check와 로그에 쓴다.
func (r *JournalReader) Err() error { return r.lastErr }

// Close는 journalctl을 끝낸다.
func (r *JournalReader) Close() error {
	r.stop()
	return nil
}

// Step은 받은 항목을 기록으로 묶어 대기에 확정하고 읽기 상태를 돌려준다. 주기적으로 부른다.
func (r *JournalReader) Step() Status {
	if r.hold {
		return r.status
	}
	if len(r.pending) > 0 && !r.flush() {
		return r.status
	}
	if r.queueFull() {
		// D01: 기존 대기는 그대로 두고 읽기만 멈춘다. journal 보관 한도로 그 사이 항목이 지워지면
		// 다시 시작할 때 알아채고 보류한다.
		r.stop()
		r.status.State, r.status.Reason = Paused, ReasonQueueFull
		return r.status
	}
	now := r.asmNow()
	if r.run == nil {
		if now.Before(r.retryAt) || !r.start(now) {
			return r.status
		}
	}
	var recs []journal.Record
	closed, got, bytes := false, 0, 0
read:
	for got < r.jo.Batch && bytes < r.jo.BatchBytes {
		select {
		case e, ok := <-r.run.Entries():
			if !ok {
				closed = true
				break read
			}
			got++
			bytes += e.Size(journal.FieldMessage)
			r.status.LastReadAt = now
			r.status.ReadBytes += int64(e.Size(journal.FieldMessage))
			if r.verify != "" {
				want := r.verify
				r.verify = ""
				if e.Ident() != want {
					// 저장한 항목이 그새 지워졌다. 이어 읽으면 그 사이를 말없이 건너뛰므로 보류한다.
					r.stop()
					r.hold = true
					r.status.State, r.status.Reason = Held, ReasonRecoveryHold
					return r.status
				}
				continue
			}
			recs = append(recs, r.pipe.Push(e)...)
		default:
			break read
		}
	}
	recs = append(recs, r.pipe.Tick()...)
	if !r.keep(recs) {
		return r.status
	}
	if len(r.pending) > 0 && !r.flush() {
		return r.status
	}
	if closed {
		err := r.run.Err()
		r.retry(now, fmt.Errorf("journalctl ended: %w", err))
		return r.status
	}
	if got > 0 {
		r.wait = 0
	}
	r.status.State, r.status.Reason = Running, ""
	return r.status
}

// start는 journalctl을 띄운다. 최초 연결이면 시작 경계를 기록하고, 아니면 저장한 항목이 아직
// 있는지 확인한 뒤 그 항목부터 읽는다.
func (r *JournalReader) start(now time.Time) bool {
	if _, err := journal.CheckAccess(r.jo.Dirs); err != nil {
		r.retry(now, err)
		return false
	}
	maxValue := r.popt.MaxEventBytes + 1
	r.pipe = journal.NewPipeline(r.popt)
	var cursor, ident string
	if r.resume == nil {
		last, found, err := journal.Probe(r.jo.Start, journal.ProbeArgs(r.jo.Target, ""), maxValue)
		if err != nil {
			r.retry(now, err)
			return false
		}
		var lp *journal.Entry
		if found {
			lp = &last
		}
		rec := r.pipe.Initial(lp)
		if !r.keep([]journal.Record{rec}) || !r.flush() {
			r.pipe = nil
			return false
		}
		cursor, ident = rec.After.Cursor, rec.After.Ident
	} else {
		pos := *r.resume
		if pos.Cursor != "" {
			e, found, err := journal.Probe(r.jo.Start, journal.ProbeArgs(r.jo.Target, pos.Cursor), maxValue)
			if err != nil {
				r.retry(now, err)
				return false
			}
			if !found || e.Ident() != pos.Ident {
				// 저장한 항목이 journal 보관 한도로 지워졌다(D02 원본 기록 삭제, Q06).
				r.pipe = nil
				r.hold = true
				r.status.State, r.status.Reason = Held, ReasonRecoveryHold
				return false
			}
		}
		r.pipe.Restore(pos)
		cursor, ident = pos.Cursor, pos.Ident
	}
	run, err := journal.Follow(r.jo.Start, journal.FollowArgs(r.jo.Target, cursor), maxValue, r.jo.Buffer)
	if err != nil {
		r.retry(now, err)
		return false
	}
	r.run = run
	r.verify = ""
	if cursor != "" {
		r.verify = ident
	}
	r.status.State, r.status.Reason = Running, ""
	return true
}

// keep은 기록을 대기에 쓸 바이트로 바꿔 들고 있는다.
func (r *JournalReader) keep(recs []journal.Record) bool {
	for _, rec := range recs {
		b, err := record.EncodeJournal(rec, r.opt.ConfigVersion)
		if err != nil {
			r.stop()
			r.status.State, r.status.Reason = Held, ReasonReadError
			r.lastErr = err
			return false
		}
		r.pending = append(r.pending, b)
		after := rec.After
		r.lastAfter = &after
		r.noteJournal(rec)
	}
	return true
}

// flush는 들고 있는 기록을 대기에 쓰고, 성공하면 재시작 위치를 마지막 기록 뒤로 옮긴다.
func (r *JournalReader) flush() bool {
	if !r.base.flush() {
		return false
	}
	if r.lastAfter != nil {
		r.resume, r.lastAfter = r.lastAfter, nil
	}
	return true
}

// stop은 journalctl을 끝내고 묶던 상태를 버린다. 다시 시작하면 확정한 위치에서 다시 묶는다.
func (r *JournalReader) stop() {
	if r.run != nil {
		r.run.Stop()
		r.run = nil
	}
	r.pipe = nil
	r.verify = ""
}

// retry는 journalctl을 끝내고 잠시 뒤 다시 띄우게 한다.
func (r *JournalReader) retry(now time.Time, err error) {
	r.stop()
	if r.wait == 0 {
		r.wait = r.jo.RetryWait
	} else {
		r.wait = min(2*r.wait, r.jo.MaxRetryWait)
	}
	r.retryAt = now.Add(r.wait)
	r.lastErr = err
	r.status.State, r.status.Reason = Held, journalReason(err)
}

func journalReason(err error) string {
	switch {
	case errors.Is(err, fs.ErrPermission):
		return ReasonPermissionDenied
	case errors.Is(err, fs.ErrNotExist) && !errors.Is(err, exec.ErrNotFound):
		return ReasonPathMissing
	default:
		return ReasonReadError
	}
}

// noteJournal은 상태 보고에 실을 거부 수와 원본에서 버려진 구간을 센다.
func (r *JournalReader) noteJournal(rec journal.Record) {
	switch {
	case rec.Kind == assemble.Rejected:
		r.status.Rejected++
	case rec.Kind == assemble.Boundary && rec.Boundary.Kind == journal.BoundarySourceDropped:
		r.status.Loss = append(r.status.Loss, Loss{Kind: rec.Boundary.Kind, ObservedAt: rec.ObservedAt, Journal: true,
			Unit: rec.Boundary.Unit, Dropped: rec.Boundary.Dropped, ShareUnknown: rec.Boundary.ShareUnknown})
		if n := len(r.status.Loss); n > maxLoss {
			r.status.Loss = append([]Loss(nil), r.status.Loss[n-maxLoss:]...)
		}
	}
}
