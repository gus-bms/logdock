// logdock-agent는 LogDock 측정용 에이전트 시제품이다.
//
//	logdock-agent run    -config /etc/logdock-agent/agent.toml   수집을 시작한다
//	logdock-agent check  -config ...                              설정·키 권한·대상을 검사만 하고 보내지 않는다
//	logdock-agent status -config ...                              연결별 읽기·보내기 상태를 보인다
//	logdock-agent version
//
// 키 원문은 어떤 출력에도 넣지 않는다(SC-02).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"

	"github.com/gus-bms/logdock/agent/internal/agent"
	"github.com/gus-bms/logdock/agent/internal/config"
	"github.com/gus-bms/logdock/agent/internal/journal"
)

const version = "0.1.0-prototype"

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	cmd := "run"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	flags := flag.NewFlagSet("logdock-agent "+cmd, flag.ContinueOnError)
	flags.SetOutput(stderr)
	cfgPath := flags.String("config", "/etc/logdock-agent/agent.toml", "agent config file")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	switch cmd {
	case "run":
		return runAgent(*cfgPath, stderr)
	case "check":
		return check(*cfgPath, stdout)
	case "status":
		return showStatus(*cfgPath, stdout)
	case "version":
		fmt.Fprintln(stdout, version)
		return 0
	default:
		fmt.Fprintf(stderr, "unknown command %q (run, check, status, version)\n", cmd)
		return 2
	}
}

func runAgent(cfgPath string, stderr io.Writer) int {
	log := slog.New(slog.NewJSONHandler(stderr, nil))
	cfg, err := config.LoadAgent(cfgPath)
	if err != nil {
		log.Error("agent config rejected", "error", err)
		return 1
	}
	rt, err := agent.New(cfg, version, log)
	if err != nil {
		log.Error("agent not started", "error", err)
		return 1
	}
	// 중지 신호를 받으면 바로 멈춘다. 남은 전송은 대기에 남아 다음 실행에서 보낸다(Q05-02).
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Info("logdock-agent started", "version", version, "instance_id", rt.InstanceID())
	if err := rt.Run(ctx); err != nil {
		log.Error("logdock-agent failed", "error", err)
		return 1
	}
	log.Info("logdock-agent stopped")
	return 0
}

// check는 설정을 적용하기 전에 쓴다. 아무것도 보내지 않는다(계약 8.3절, AT-06).
func check(cfgPath string, out io.Writer) int {
	cfg, err := config.LoadAgent(cfgPath)
	if err != nil {
		fmt.Fprintf(out, "FAIL agent config: %v\n", err)
		return 1
	}
	failed := false
	if err := checkWritable(cfg.StateDir); err != nil {
		fmt.Fprintf(out, "FAIL state_dir: %v\n", err)
		failed = true
	}
	conns, errs := config.LoadConnections(cfg.ConnectionsDir)
	files := make([]string, 0, len(errs))
	for f := range errs {
		files = append(files, f)
	}
	sort.Strings(files)
	for _, f := range files {
		fmt.Fprintf(out, "FAIL %s: %v\n", filepath.Base(f), errs[f])
		failed = true
	}
	for _, c := range conns {
		var problems, warnings []string
		if err := c.CheckAgainst(cfg); err != nil {
			problems = append(problems, err.Error())
		}
		if err := config.CheckKeyFile(c.KeyPath); err != nil {
			problems = append(problems, err.Error())
		}
		if _, err := c.HTTPClient(); err != nil {
			problems = append(problems, err.Error())
		}
		target := c.Target.Path
		switch c.Target.Type {
		case "journald":
			target = c.Target.Kind + " " + c.Target.Name
			problems, warnings = checkJournal(problems, warnings)
		case "file_pattern":
			n, compressed, err := matchCount(c.Target.Path)
			switch {
			case errors.Is(err, fs.ErrNotExist):
				warnings = append(warnings, "target folder does not exist yet; files created in it later will be read from their start")
			case err != nil:
				problems = append(problems, "target: "+err.Error())
			case n == 0:
				warnings = append(warnings, "no file matches yet; files created later will be read from their start")
			}
			if compressed > 0 {
				// 압축 파일을 글로 읽으면 깨진 본문만 쌓인다. 규칙을 좁히라고 알린다.
				warnings = append(warnings, fmt.Sprintf("%d matching files look compressed (.gz and the like) and would be read as text; narrow the pattern", compressed))
			}
			target = fmt.Sprintf("%s, %d files match", c.Target.Path, n)
		default:
			switch err := checkReadable(c.Target.Path); {
			case errors.Is(err, fs.ErrNotExist):
				// 연결한 뒤 생기는 파일은 처음부터 읽는다(D02). 막지 않고 알리기만 한다.
				warnings = append(warnings, "target file does not exist yet; it will be read from its start once created")
			case err != nil:
				problems = append(problems, "target: "+err.Error())
			}
		}
		switch {
		case len(problems) > 0:
			fmt.Fprintf(out, "FAIL %s: %s\n", c.ID, strings.Join(problems, "; "))
			failed = true
		case len(warnings) > 0:
			fmt.Fprintf(out, "WARN %s: %s\n", c.ID, strings.Join(warnings, "; "))
		default:
			fmt.Fprintf(out, "OK   %s: %s (%s, config version %d)\n", c.ID, target, c.Format.Type, c.ConfigVersion)
		}
	}
	if len(conns) == 0 && len(errs) == 0 {
		fmt.Fprintln(out, "WARN no connection config found")
	}
	if failed {
		return 1
	}
	return 0
}

// journalDirs와 journalctlPath는 시험이 바꾼다.
var (
	journalDirs    = journal.DefaultDirs
	journalctlPath = "journalctl"
)

// checkJournal은 journald 연결의 읽기 조건을 본다. journalctl은 권한이 없어도 실패하지 않고 빈
// 결과를 내므로 journal 파일을 직접 열어 본다. 메모리에만 보관하는 journal은 막지 않고 알린다.
func checkJournal(problems, warnings []string) ([]string, []string) {
	if _, err := exec.LookPath(journalctlPath); err != nil {
		problems = append(problems, "journalctl not found in PATH")
	}
	persistent, err := journal.CheckAccess(journalDirs)
	switch {
	case errors.Is(err, fs.ErrPermission):
		problems = append(problems, "cannot read the system journal; add the agent account to the systemd-journal group")
	case err != nil:
		problems = append(problems, "no system journal file found under "+strings.Join(journalDirs, " or "))
	case !persistent:
		warnings = append(warnings, "the journal is kept in memory only (Storage=volatile); entries not yet read are lost at reboot")
	}
	return problems, warnings
}

// matchCount는 파일명 규칙에 지금 맞는 일반 파일 수와, 그 가운데 압축 파일로 보이는 수다.
// 에이전트처럼 하위 폴더와 심볼릭 링크는 세지 않는다.
func matchCount(pattern string) (n, compressed int, err error) {
	entries, err := os.ReadDir(filepath.Dir(pattern))
	if err != nil {
		return 0, 0, err
	}
	for _, e := range entries {
		if !e.Type().IsRegular() {
			continue
		}
		if ok, _ := filepath.Match(filepath.Base(pattern), e.Name()); !ok {
			continue
		}
		n++
		switch strings.ToLower(filepath.Ext(e.Name())) {
		case ".gz", ".bz2", ".xz", ".zst", ".lz4", ".zip":
			compressed++
		}
	}
	return n, compressed, nil
}

func checkReadable(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	return f.Close()
}

func checkWritable(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".check-*")
	if err != nil {
		return err
	}
	f.Close()
	return os.Remove(f.Name())
}

// showStatus는 실행 중인 에이전트가 남긴 로컬 상태 파일을 보인다.
func showStatus(cfgPath string, out io.Writer) int {
	cfg, err := config.LoadAgent(cfgPath)
	if err != nil {
		fmt.Fprintf(out, "FAIL agent config: %v\n", err)
		return 1
	}
	files, err := filepath.Glob(filepath.Join(agent.LocalStatusDir(cfg), "*.json"))
	if err != nil || len(files) == 0 {
		fmt.Fprintln(out, "no status yet (is logdock-agent running?)")
		return 0
	}
	sort.Strings(files)
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var s struct {
			ConnectionID string `json:"connection_id"`
			UpdatedAt    string `json:"updated_at"`
			Error        string `json:"error"`
			ReadState    string `json:"read_state"`
			ReadReason   string `json:"read_reason"`
			SendState    string `json:"send_state"`
			SendReason   string `json:"send_reason"`
			AckedThrough uint64 `json:"acked_through"`
			QueueRecords uint64 `json:"queue_records"`
			QueueBytes   int64  `json:"queue_bytes"`
			Stopped      bool   `json:"stopped"`
		}
		if json.Unmarshal(b, &s) != nil {
			continue
		}
		if s.Error != "" {
			fmt.Fprintf(out, "%s  not started: %s  (updated %s)\n", s.ConnectionID, s.Error, s.UpdatedAt)
			continue
		}
		state := ""
		if s.Stopped {
			state = "  stopped"
		}
		fmt.Fprintf(out, "%s  read=%s  send=%s  queue=%d records (%d bytes)  acked=%d  updated %s%s\n",
			s.ConnectionID, withReason(s.ReadState, s.ReadReason), withReason(s.SendState, s.SendReason),
			s.QueueRecords, s.QueueBytes, s.AckedThrough, s.UpdatedAt, state)
	}
	return 0
}

func withReason(state, reason string) string {
	if reason == "" {
		return state
	}
	return state + "(" + reason + ")"
}
