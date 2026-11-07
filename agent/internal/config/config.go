// Package config는 에이전트 설정 파일을 읽고 검사한다(계약 초안 2.8절).
//
// 연결마다 설정 파일 <connection_id>.toml과 키 파일 <connection_id>.key를 한 폴더에 두고,
// 에이전트 전체 설정은 따로 둔다. 모르는 키는 오타일 수 있으므로 무시하지 않고 오류로 알린다.
package config

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gus-bms/logdock/agent/internal/rules"
)

// Agent는 에이전트 전체 설정이다. 기본값은 시제품용이다.
type Agent struct {
	Path            string
	ConnectionsDir  string // 연결 설정과 키 파일이 있는 폴더
	StateDir        string // 대기·인스턴스 ID·로컬 상태를 두는 폴더. 원본 로그와 다른 곳이어야 한다
	QueueLimitBytes int64
	PollInterval    time.Duration
	StatusInterval  time.Duration
}

// Connection은 수집 연결 하나의 설정이다.
type Connection struct {
	File          string
	ID            string
	ConfigVersion int
	IngestURL     string
	CAFile        string
	KeyPath       string
	Target        Target
	Format        Format
}

// Target은 수집 대상이다. 규칙은 internal/rules가 기준이다(등록 API와 같은 코드).
type Target struct {
	Type string // file | file_pattern | journald
	Path string
	// journald: 대상 종류(container | unit)와 이름. unit 이름에 종류 접미사가 없으면 .service를 붙인다.
	Kind string
	Name string
}

// Format은 이벤트를 나누는 방식이다. 시각·레벨·필드 해석은 수신 서버가 한다(D17-03).
type Format struct {
	Type          string // text | json | multiline
	EventStart    *regexp.Regexp
	LogTimezone   string
	MaxEventBytes int
}

var connID = regexp.MustCompile(`^c_[a-z0-9]+$`)

// LoadAgent는 에이전트 전체 설정을 읽는다.
func LoadAgent(path string) (Agent, error) {
	doc, err := readTOML(path)
	if err != nil {
		return Agent{}, err
	}
	a := Agent{Path: path, QueueLimitBytes: 256 << 20, PollInterval: 250 * time.Millisecond, StatusInterval: 30 * time.Second}
	r := newReader(path, doc, "")
	a.ConnectionsDir = r.path("connections_dir", true)
	a.StateDir = r.path("state_dir", true)
	if v, ok := r.integer("queue_limit_bytes", 1<<20, 1<<40); ok {
		a.QueueLimitBytes = v
	}
	if v, ok := r.integer("poll_interval_ms", 10, 60_000); ok {
		a.PollInterval = time.Duration(v) * time.Millisecond
	}
	if v, ok := r.integer("status_interval_ms", 100, 3_600_000); ok {
		a.StatusInterval = time.Duration(v) * time.Millisecond
	}
	if err := r.finish(doc, ""); err != nil {
		return Agent{}, err
	}
	if a.StateDir != "" && a.StateDir == a.ConnectionsDir {
		return Agent{}, fmt.Errorf("%s: state_dir must differ from connections_dir", path)
	}
	return a, nil
}

// LoadConnections는 폴더의 연결 설정을 모두 읽는다. 잘못된 파일이 있어도 나머지 연결은
// 돌려준다. 안전하게 나눌 수 있는 다른 수집은 계속하기 위해서다(D05).
func LoadConnections(dir string) ([]Connection, map[string]error) {
	errs := map[string]error{}
	files, err := filepath.Glob(filepath.Join(dir, "*.toml"))
	if err != nil {
		errs[dir] = err
		return nil, errs
	}
	sort.Strings(files)
	var out []Connection
	for _, f := range files {
		c, err := LoadConnection(f)
		if err != nil {
			errs[f] = err
			continue
		}
		out = append(out, c)
	}
	return out, errs
}

// LoadConnection은 연결 설정 파일 하나를 읽고 검사한다.
func LoadConnection(path string) (Connection, error) {
	doc, err := readTOML(path)
	if err != nil {
		return Connection{}, err
	}
	c := Connection{File: path}
	r := newReader(path, doc, "")
	c.ID = r.str("connection_id", true)
	if v, ok := r.integer("config_version", 1, 1<<31-1); ok {
		c.ConfigVersion = int(v)
	} else {
		r.fail("config_version is required")
	}
	c.IngestURL = r.str("ingest_url", true)
	c.CAFile = r.path("ca_file", false)

	t := newReader(path, doc, "target")
	c.Target.Type = t.str("type", true)
	// 절대 경로인지는 rules.CheckTarget이 본다(등록 API와 같은 문장·사유).
	c.Target.Path = t.str("path", false)
	c.Target.Kind = t.str("kind", false)
	c.Target.Name = t.str("name", false)

	f := newReader(path, doc, "format")
	c.Format.Type = f.str("type", true)
	start := f.str("event_start", false)
	c.Format.LogTimezone = f.str("log_timezone", false)
	if v, ok := f.integer("max_event_bytes", 1, 64<<20); ok {
		c.Format.MaxEventBytes = int(v)
	} else {
		f.fail("max_event_bytes is required")
	}

	var errs []error
	for _, rd := range []*reader{r, t, f} {
		if err := rd.finish(doc, rd.table); err != nil {
			errs = append(errs, err)
		}
	}
	for name := range doc {
		if name != "" && name != "target" && name != "format" {
			errs = append(errs, fmt.Errorf("%s: unknown table [%s]", path, name))
		}
	}
	errs = append(errs, c.validate(start)...)
	if err := errors.Join(errs...); err != nil {
		return Connection{}, err
	}
	c.KeyPath = filepath.Join(filepath.Dir(path), c.ID+".key")
	return c, nil
}

// validate는 계약 초안 2.8절의 입력 규칙을 검사한다.
func (c *Connection) validate(start string) []error {
	var errs []error
	bad := func(format string, args ...any) {
		errs = append(errs, fmt.Errorf("%s: "+format, append([]any{c.File}, args...)...))
	}
	if c.ID != "" && !connID.MatchString(c.ID) {
		bad("connection_id %q is not a LogDock connection id", c.ID)
	}
	if c.ID != "" && filepath.Base(c.File) != c.ID+".toml" {
		bad("file name must be %s.toml", c.ID)
	}
	if u, err := url.Parse(c.IngestURL); c.IngestURL != "" && (err != nil || u.Scheme != "https" || u.Host == "") {
		bad("ingest_url must be an https URL (Q10-02)")
	}
	// 수집 대상과 형식은 등록 API와 같은 함수로 검사한다(internal/rules).
	target, problems := rules.CheckTarget(rules.Target(c.Target))
	c.Target = Target(target)
	re, formatProblems := rules.CheckFormat(c.Format.Type, start)
	c.Format.EventStart = re
	for _, p := range append(problems, formatProblems...) {
		errs = append(errs, fmt.Errorf("%s: %s", c.File, p.Message))
	}
	if c.Format.LogTimezone != "" {
		if _, err := time.LoadLocation(c.Format.LogTimezone); err != nil {
			bad("format.log_timezone %q is not an IANA time zone", c.Format.LogTimezone)
		}
	}
	return errs
}

// CheckAgainst는 연결이 에이전트 전체 설정과 부딪히는지 본다. 수집 대상 폴더가 상태 폴더이거나
// 그 아래면 에이전트가 자기 대기를 로그로 다시 읽으므로 막는다(수집 명세 Q02-06 자체 재수집 방지).
func (c Connection) CheckAgainst(a Agent) error {
	if c.Target.Path == "" || a.StateDir == "" {
		return nil
	}
	rel, err := filepath.Rel(a.StateDir, filepath.Dir(c.Target.Path))
	if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("%s: target.path must not be inside state_dir; the agent would read its own queue", c.File)
	}
	return nil
}

// CheckKeyFile은 키 파일이 있고 실행 계정만 읽을 수 있는지 본다(SC-03). 키 내용은 오류에 넣지 않는다.
func CheckKeyFile(path string) error {
	fi, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("key file: %w", err)
	}
	if perm := fi.Mode().Perm(); perm&0o077 != 0 {
		return fmt.Errorf("key file %s is readable by other accounts (mode %04o); set it to 0600", path, perm)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("key file: %w", err)
	}
	if !strings.HasPrefix(strings.TrimSpace(string(b)), "ldk_") {
		return fmt.Errorf("key file %s does not hold a LogDock key", path)
	}
	return nil
}

// HTTPClient는 수신 서버에 쓸 클라이언트다. 인증서와 호스트 이름을 검증하고, 검증을 끄는
// 설정은 두지 않는다(SC-02). 사설 CA면 ca_file로 그 CA를 믿는다.
func (c Connection) HTTPClient() (*http.Client, error) {
	tc := &tls.Config{MinVersion: tls.VersionTLS12}
	if c.CAFile != "" {
		pem, err := os.ReadFile(c.CAFile)
		if err != nil {
			return nil, fmt.Errorf("ca_file: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("ca_file %s holds no PEM certificate", c.CAFile)
		}
		tc.RootCAs = pool
	}
	tr := &http.Transport{
		TLSClientConfig:     tc,
		MaxIdleConnsPerHost: 2,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 10 * time.Second,
		ForceAttemptHTTP2:   true,
	}
	return &http.Client{Transport: tr}, nil
}

func readTOML(path string) (map[string]table, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	doc, err := parseTOML(b)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return doc, nil
}

// reader는 표 하나에서 값을 꺼내며 쓴 키를 기억한다. 남은 키는 모르는 키다.
type reader struct {
	file  string
	table string
	t     table
	used  map[string]bool
	errs  []error
}

func newReader(file string, doc map[string]table, name string) *reader {
	return &reader{file: file, table: name, t: doc[name], used: map[string]bool{}}
}

func (r *reader) name(key string) string {
	if r.table == "" {
		return key
	}
	return r.table + "." + key
}

func (r *reader) fail(format string, args ...any) {
	r.errs = append(r.errs, fmt.Errorf("%s: "+format, append([]any{r.file}, args...)...))
}

func (r *reader) str(key string, required bool) string {
	r.used[key] = true
	v, ok := r.t[key]
	if !ok {
		if required {
			r.fail("%s is required", r.name(key))
		}
		return ""
	}
	s, ok := v.(string)
	if !ok {
		r.fail("%s must be a string", r.name(key))
	}
	return s
}

func (r *reader) path(key string, required bool) string {
	p := r.str(key, required)
	if p != "" && !filepath.IsAbs(p) {
		r.fail("%s must be an absolute path", r.name(key))
	}
	return p
}

func (r *reader) integer(key string, lo, hi int64) (int64, bool) {
	r.used[key] = true
	v, ok := r.t[key]
	if !ok {
		return 0, false
	}
	n, ok := v.(int64)
	if !ok || n < lo || n > hi {
		r.fail("%s must be an integer from %d to %d", r.name(key), lo, hi)
		return 0, false
	}
	return n, true
}

func (r *reader) finish(doc map[string]table, name string) error {
	for key := range doc[name] {
		if !r.used[key] {
			r.fail("unknown key %s", r.name(key))
		}
	}
	return errors.Join(r.errs...)
}
