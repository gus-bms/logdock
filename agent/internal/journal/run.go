package journal

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// Matches는 대상과 journald 속도 제한 알림을 함께 고르는 journalctl 조건이다. "+"는 앞뒤 조건을
// 또는으로 잇는다(journalctl(1)). 컨테이너는 Docker 드라이버의 CONTAINER_NAME(시작할 때의 이름),
// unit은 _SYSTEMD_UNIT으로 고른다. journalctl -u는 systemd가 그 unit에 대해 남긴 메시지와 코어
// 덤프까지 더하므로 쓰지 않는다.
func Matches(t Target) []string {
	var m []string
	switch t.Kind {
	case "container":
		m = []string{FieldContainerName + "=" + t.Name}
	case "unit":
		m = []string{FieldSystemdUnit + "=" + t.Name}
	}
	return append(m, "+", FieldMessageID+"="+MessageIDDropped)
}

// FollowArgs는 cursor 항목부터 계속 읽는 journalctl 인자다. cursor 항목도 출력에 들어오므로 첫
// 항목이 저장한 항목인지 확인한 뒤 건너뛴다. --after-cursor를 쓰지 않는 것은 그 항목이 이미
// 지워졌을 때 가까운 다음 항목으로 옮겨 가 알아챌 수 없기 때문이다(sd_journal_seek_cursor(3)).
// --no-tail은 --follow가 최근 10개만 보여 주는 동작을 없앤다.
func FollowArgs(t Target, cursor string) []string {
	a := []string{"--system", "--output=export", "--follow", "--no-tail", "--no-pager"}
	if cursor != "" {
		a = append(a, "--cursor="+cursor)
	}
	return append(a, Matches(t)...)
}

// ProbeArgs는 확인용 journalctl 인자다. cursor가 비면 대상과 알림 가운데 마지막 항목 하나,
// 아니면 cursor 항목부터다(첫 항목만 읽고 끝낸다).
func ProbeArgs(t Target, cursor string) []string {
	a := []string{"--system", "--output=export", "--no-pager"}
	if cursor == "" {
		a = append(a, "--lines=1")
	} else {
		a = append(a, "--cursor="+cursor)
	}
	return append(a, Matches(t)...)
}

// Proc는 띄운 journalctl 하나다.
type Proc interface {
	Stdout() io.Reader
	// Wait는 스스로 끝날 때까지 기다린다. 0이 아닌 종료 코드면 오류다.
	Wait() error
	// Stop은 끝내고 기다린다. 여러 번 불러도 된다.
	Stop()
}

// Starter는 journalctl을 띄운다. 시험은 가짜를 넣는다.
type Starter func(args []string) (Proc, error)

// ExecStarter는 실제 journalctl을 띄운다. 오류 출력은 끝 4KiB만 남겨 오류에 붙인다.
func ExecStarter(path string, env []string) Starter {
	return func(args []string) (Proc, error) {
		cmd := exec.Command(path, args...)
		if env != nil {
			cmd.Env = env
		}
		p := &execProc{cmd: cmd, stderr: &tailBuffer{max: 4 << 10}}
		cmd.Stderr = p.stderr
		out, err := cmd.StdoutPipe()
		if err != nil {
			return nil, err
		}
		if err := cmd.Start(); err != nil {
			return nil, err
		}
		p.out = out
		return p, nil
	}
}

type execProc struct {
	cmd    *exec.Cmd
	out    io.Reader
	stderr *tailBuffer
	once   sync.Once
	err    error
}

func (p *execProc) Stdout() io.Reader { return p.out }

func (p *execProc) Wait() error {
	p.once.Do(func() { p.err = p.cmd.Wait() })
	if p.err != nil {
		if msg := strings.TrimSpace(p.stderr.String()); msg != "" {
			return fmt.Errorf("journalctl: %w: %s", p.err, msg)
		}
		return fmt.Errorf("journalctl: %w", p.err)
	}
	return nil
}

func (p *execProc) Stop() {
	_ = p.cmd.Process.Kill()
	p.once.Do(func() { p.err = p.cmd.Wait() })
}

// tailBuffer는 끝 max 바이트만 남기는 버퍼다.
type tailBuffer struct {
	mu  sync.Mutex
	buf []byte
	max int
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buf = append(b.buf, p...)
	if over := len(b.buf) - b.max; over > 0 {
		b.buf = append(b.buf[:0], b.buf[over:]...)
	}
	return len(p), nil
}

func (b *tailBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(bytes.ToValidUTF8(b.buf, []byte("?")))
}

// Probe는 항목 하나만 읽고 journalctl을 끝낸다. 출력이 없으면 ok는 false다. journalctl이 실패로
// 끝났으면 항목이 없다고 보지 않고 오류를 돌려준다. 저장한 위치가 사라졌다고 잘못 판단해
// 복구 보류로 가지 않기 위해서다.
func Probe(start Starter, args []string, maxValue int) (Entry, bool, error) {
	p, err := start(args)
	if err != nil {
		return Entry{}, false, err
	}
	e, err := NewParser(p.Stdout(), maxValue).Next()
	if err == nil {
		p.Stop()
		return e, true, nil
	}
	if !errors.Is(err, io.EOF) {
		p.Stop()
		return Entry{}, false, err
	}
	if err := p.Wait(); err != nil {
		return Entry{}, false, err
	}
	return Entry{}, false, nil
}

// Run은 계속 읽는 journalctl 하나다. 고루틴 하나가 출력을 항목으로 읽어 채널로 넘긴다. 채널이
// 차면 고루틴이 멈추고 journalctl도 출력 파이프에서 멈춘다.
type Run struct {
	proc    Proc
	entries chan Entry
	stop    chan struct{}
	done    chan struct{}
	once    sync.Once
	err     error
}

// Follow는 journalctl을 띄우고 읽기 시작한다. buf는 채널에 쌓아 둘 항목 수다.
func Follow(start Starter, args []string, maxValue, buf int) (*Run, error) {
	p, err := start(args)
	if err != nil {
		return nil, err
	}
	r := &Run{proc: p, entries: make(chan Entry, buf), stop: make(chan struct{}), done: make(chan struct{})}
	go r.loop(maxValue)
	return r, nil
}

func (r *Run) loop(maxValue int) {
	defer close(r.done)
	defer close(r.entries)
	ps := NewParser(r.proc.Stdout(), maxValue)
	for {
		e, err := ps.Next()
		if err != nil {
			select {
			case <-r.stop:
			default:
				if errors.Is(err, io.EOF) {
					err = r.proc.Wait()
					if err == nil {
						err = io.EOF // --follow는 스스로 끝나지 않는다
					}
				}
				r.err = err
			}
			return
		}
		select {
		case r.entries <- e:
		case <-r.stop:
			return
		}
	}
}

// Entries는 읽은 항목이다. journalctl이 끝나면 닫힌다.
func (r *Run) Entries() <-chan Entry { return r.entries }

// Err는 채널이 닫힌 뒤 끝난 까닭이다.
func (r *Run) Err() error {
	<-r.done
	return r.err
}

// Stop은 journalctl을 끝내고 읽기 고루틴을 기다린다. 채널에 남은 항목은 버린다.
func (r *Run) Stop() {
	r.once.Do(func() {
		close(r.stop)
		r.proc.Stop()
		for range r.entries {
		}
		<-r.done
	})
}

// DefaultDirs는 journal 파일 위치다. 첫째는 디스크(영구 보관), 둘째는 메모리(재부팅 때 지워짐)다
// (journald.conf(5) Storage=).
var DefaultDirs = []string{"/var/log/journal", "/run/log/journal"}

// CheckAccess는 읽을 수 있는 system journal 파일이 있는지 본다. journalctl은 권한이 없어도 실패하지
// 않고 볼 수 있는 항목만 보여 주므로, 읽기 전에 파일로 직접 확인한다. 시스템 journal은 root와
// systemd-journal·adm·wheel 그룹만 읽을 수 있다(journalctl(1)). persistent는 첫째 폴더(디스크)에서
// 읽을 수 있는 파일을 찾았는지다. 파일은 있는데 못 읽으면 fs.ErrPermission, 파일이 없으면
// fs.ErrNotExist다.
func CheckAccess(dirs []string) (persistent bool, err error) {
	denied := false
	for i, d := range dirs {
		subs, err := os.ReadDir(d)
		if errors.Is(err, fs.ErrPermission) {
			denied = true
			continue
		}
		for _, s := range subs {
			if !s.IsDir() {
				continue
			}
			files, err := os.ReadDir(filepath.Join(d, s.Name()))
			if errors.Is(err, fs.ErrPermission) {
				denied = true
				continue
			}
			for _, f := range files {
				name := f.Name()
				if !strings.HasPrefix(name, "system") || !strings.HasSuffix(name, ".journal") {
					continue
				}
				fh, err := os.Open(filepath.Join(d, s.Name(), name))
				if err == nil {
					fh.Close()
					return i == 0, nil
				}
				if errors.Is(err, fs.ErrPermission) {
					denied = true
				}
			}
		}
	}
	if denied {
		return false, fs.ErrPermission
	}
	return false, fs.ErrNotExist
}
