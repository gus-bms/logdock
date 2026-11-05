//go:build unix

package agent

import (
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// sampler는 프로세스 CPU 사용 비율을 두 측정 사이의 차이로 잰다. 1이면 논리 코어 하나를
// 다 쓴 것이다. 첫 측정은 비교할 앞 값이 없어 모름(nil)이다.
type sampler struct {
	lastCPU  time.Duration
	lastWall time.Time
}

func (s *sampler) cpuRatio(now time.Time) *float64 {
	var ru syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err != nil {
		return nil
	}
	cpu := timeval(ru.Utime) + timeval(ru.Stime)
	prevCPU, prevWall := s.lastCPU, s.lastWall
	s.lastCPU, s.lastWall = cpu, now
	if prevWall.IsZero() || !now.After(prevWall) {
		return nil
	}
	r := float64(cpu-prevCPU) / float64(now.Sub(prevWall))
	return &r
}

func timeval(tv syscall.Timeval) time.Duration {
	return time.Duration(tv.Sec)*time.Second + time.Duration(tv.Usec)*time.Microsecond
}

// rssBytes는 지금 상주 메모리다. Linux의 /proc에서 읽고, 없으면(macOS 등) 모름이다.
func rssBytes() *int64 {
	b, err := os.ReadFile("/proc/self/statm")
	if err != nil {
		return nil
	}
	f := strings.Fields(string(b))
	if len(f) < 2 {
		return nil
	}
	pages, err := strconv.ParseInt(f[1], 10, 64)
	if err != nil {
		return nil
	}
	v := pages * int64(os.Getpagesize())
	return &v
}

// openFiles는 열린 파일 수다. Linux의 /proc에서 세고, 없으면 모름이다.
func openFiles() *int {
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		return nil
	}
	n := len(entries)
	return &n
}

// systemTimezone은 에이전트 서버의 IANA 시간대 이름이다(Q08-06). 알 수 없으면 빈 문자열이다.
func systemTimezone() string {
	if tz := strings.TrimPrefix(os.Getenv("TZ"), ":"); tz != "" {
		if _, err := time.LoadLocation(tz); err == nil {
			return tz
		}
	}
	if p, err := os.Readlink("/etc/localtime"); err == nil {
		if i := strings.Index(p, "zoneinfo/"); i >= 0 {
			return p[i+len("zoneinfo/"):]
		}
	}
	if b, err := os.ReadFile("/etc/timezone"); err == nil {
		return strings.TrimSpace(string(b))
	}
	return ""
}
