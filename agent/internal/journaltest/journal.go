// Package journaltest는 시험용 가짜 journal이다. journalctl 대신 journal.Starter로 넣는다.
//
// 실제 journalctl과 같게 하는 동작: 조건(같은 필드는 또는, 다른 필드는 그리고, "+"는 또는),
// --cursor는 그 항목부터이고 항목이 지워졌으면 가까운 다음 항목부터, --lines=1은 마지막 항목
// 하나, --follow는 새 항목을 기다림, 출력은 export 형식. 읽는 쪽이 느리면 쓰기가 멈춘다.
package journaltest

import (
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"

	"github.com/gus-bms/logdock/agent/internal/journal"
)

// Journal은 가짜 journal이다. 여러 고루틴에서 써도 된다.
type Journal struct {
	mu      sync.Mutex
	seq     int
	entries []item
	wake    chan struct{}
	calls   [][]string
	procs   []*proc
	// StartErr가 있으면 띄우기에 실패한다.
	StartErr error
	// ExitErr가 있으면 --follow가 아닌 실행이 출력을 마친 뒤 이 오류로 끝난다.
	ExitErr error
}

type item struct {
	seq int
	e   journal.Entry
}

// New는 빈 journal을 만든다.
func New() *Journal { return &Journal{wake: make(chan struct{})} }

// Add는 항목을 더하고 커서를 돌려준다. 인자는 "이름=값"이다. 커서·두 시각·부팅 ID는 붙여 준다.
func (j *Journal) Add(fields ...string) string {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.seq++
	cursor := fmt.Sprintf("s=fake;i=%d", j.seq)
	all := append([]string{
		journal.FieldCursor + "=" + cursor,
		journal.FieldRealtime + "=" + strconv.Itoa(1_762_400_000_000_000+j.seq*1000),
		journal.FieldMonotonic + "=" + strconv.Itoa(j.seq*1000),
		journal.FieldBootID + "=b0071d",
	}, fields...)
	j.entries = append(j.entries, item{seq: j.seq, e: journal.NewEntry(all...)})
	close(j.wake)
	j.wake = make(chan struct{})
	return cursor
}

// Vacuum은 오래된 항목 n개를 지운다(보관 한도로 journal 파일이 지워진 것처럼).
func (j *Journal) Vacuum(n int) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.entries = j.entries[min(n, len(j.entries)):]
}

// Calls는 지금까지 받은 journalctl 인자다.
func (j *Journal) Calls() [][]string {
	j.mu.Lock()
	defer j.mu.Unlock()
	return append([][]string(nil), j.calls...)
}

// Start는 journal.Starter다.
func (j *Journal) Start(args []string) (journal.Proc, error) {
	j.mu.Lock()
	j.calls = append(j.calls, append([]string(nil), args...))
	startErr, exitErr := j.StartErr, j.ExitErr
	j.mu.Unlock()
	if startErr != nil {
		return nil, startErr
	}
	q, err := parseArgs(args)
	if err != nil {
		return nil, err
	}
	pr, pw := io.Pipe()
	p := &proc{r: pr, w: pw, stop: make(chan struct{}), done: make(chan struct{})}
	if !q.follow {
		p.exitErr = exitErr
	}
	j.mu.Lock()
	j.procs = append(j.procs, p)
	j.mu.Unlock()
	go func() {
		defer close(p.done)
		err := j.serve(q, pw, p.stop)
		pw.CloseWithError(err)
	}()
	return p, nil
}

// ErrCrashed는 Crash로 끝난 journalctl의 출력 오류다.
var ErrCrashed = errors.New("journaltest: journalctl crashed")

// Crash는 실행 중인 journalctl을 모두 비정상으로 끝낸다.
func (j *Journal) Crash() {
	j.mu.Lock()
	procs := j.procs
	j.procs = nil
	j.mu.Unlock()
	for _, p := range procs {
		p.w.CloseWithError(ErrCrashed)
		p.once.Do(func() { close(p.stop) })
	}
}

type query struct {
	follow bool
	last   bool
	cursor int // 0이면 처음부터
	groups []map[string][]string
}

func parseArgs(args []string) (query, error) {
	var q query
	group := map[string][]string{}
	for _, a := range args {
		switch {
		case a == "--follow":
			q.follow = true
		case a == "--lines=1":
			q.last = true
		case strings.HasPrefix(a, "--cursor="):
			_, n, ok := strings.Cut(strings.TrimPrefix(a, "--cursor="), ";i=")
			v, err := strconv.Atoi(n)
			if !ok || err != nil {
				return q, fmt.Errorf("journaltest: bad cursor %q", a)
			}
			q.cursor = v
		case strings.HasPrefix(a, "--"):
		case a == "+":
			q.groups = append(q.groups, group)
			group = map[string][]string{}
		default:
			name, v, ok := strings.Cut(a, "=")
			if !ok {
				return q, fmt.Errorf("journaltest: bad match %q", a)
			}
			group[name] = append(group[name], v)
		}
	}
	if len(group) > 0 {
		q.groups = append(q.groups, group)
	}
	return q, nil
}

func (q query) match(e journal.Entry) bool {
	if len(q.groups) == 0 {
		return true
	}
	for _, g := range q.groups {
		ok := true
		for name, vals := range g {
			found := false
			for _, v := range vals {
				if e.Has(name) && e.String(name) == v {
					found = true
				}
			}
			ok = ok && found
		}
		if ok {
			return true
		}
	}
	return false
}

func (j *Journal) serve(q query, w io.Writer, stop chan struct{}) error {
	if q.last {
		j.mu.Lock()
		var last *journal.Entry
		for i := range j.entries {
			if q.match(j.entries[i].e) {
				last = &j.entries[i].e
			}
		}
		j.mu.Unlock()
		if last != nil {
			if err := journal.WriteExport(w, *last); err != nil {
				return err
			}
		}
		return nil
	}
	next := q.cursor // 다음에 보낼 항목의 최소 순번
	for {
		j.mu.Lock()
		var batch []item
		for _, it := range j.entries {
			if it.seq >= next && q.match(it.e) {
				batch = append(batch, it)
			}
		}
		if n := len(j.entries); n > 0 {
			next = max(next, j.entries[n-1].seq+1)
		}
		wake := j.wake
		j.mu.Unlock()
		for _, it := range batch {
			if err := journal.WriteExport(w, it.e); err != nil {
				return err
			}
		}
		if !q.follow {
			return nil
		}
		select {
		case <-wake:
		case <-stop:
			return io.ErrClosedPipe
		}
	}
}

type proc struct {
	r       *io.PipeReader
	w       *io.PipeWriter
	stop    chan struct{}
	done    chan struct{}
	once    sync.Once
	exitErr error
}

func (p *proc) Stdout() io.Reader { return p.r }

func (p *proc) Wait() error {
	<-p.done
	return p.exitErr
}

func (p *proc) Stop() {
	p.once.Do(func() { close(p.stop) })
	p.r.Close()
	<-p.done
}
