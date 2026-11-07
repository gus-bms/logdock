// Package rules는 수집 대상과 형식의 입력 규칙이다(계약 2.8절).
//
// 에이전트의 설정 파일 검사(internal/config)와 조회·관리 API의 등록·사전 검사가 같은 함수를 쓴다. API는 이 패키지를
// WebAssembly로 빌드한 cmd/logdock-rules를 불러 쓰므로, 화면에서 통과한 규칙을 에이전트가 거부하는 일이 없다.
// WebAssembly 크기를 작게 두려고 네트워크·파일 같은 다른 패키지에 기대지 않는다.
package rules

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"regexp/syntax"
	"strings"
	"unicode"
)

// Target은 수집 대상이다. 종류는 file | file_pattern | journald이고, journald는 대상 종류(container | unit)와 이름을 쓴다.
type Target struct {
	Type string
	Path string
	Kind string
	Name string
}

var (
	// containerName은 받는 컨테이너 이름이다. 영문자·숫자로 시작하고 영문자·숫자·_ . -만 쓴다.
	// 와일드카드와 빈 이름을 막아 호스트 전체를 고르지 못하게 한다.
	containerName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`)
	// unitName은 받는 unit 이름이다. 영문자·숫자와 : - _ . \ @만 쓴다(와일드카드 불가).
	unitName = regexp.MustCompile(`^[a-zA-Z0-9:_.\\@-]+$`)
	// unitSuffixes는 systemd unit 종류 접미사다. 없으면 .service로 본다.
	unitSuffixes = []string{".service", ".socket", ".device", ".mount", ".automount", ".swap", ".target",
		".path", ".timer", ".slice", ".scope"}
)

// Problem은 수집 대상·형식 검사에서 찾은 문제 하나다.
type Problem struct {
	Field   string `json:"field"`          // 설정 파일의 키(target.path 등)
	Code    string `json:"code"`           // 등록 API가 화면에 주는 사유 코드
	Message string `json:"message"`        // 사람이 읽는 문장. 에이전트 오류에 쓴다
	Expr    string `json:"expr,omitempty"` // 정규식 오류가 난 부분. 화면이 위치를 표시한다
}

func problem(field, code, format string, args ...any) Problem {
	return Problem{Field: field, Code: code, Message: fmt.Sprintf(format, args...)}
}

func hasControl(s string) bool {
	return strings.IndexFunc(s, unicode.IsControl) >= 0
}

// CheckTarget은 수집 대상을 검사한다. unit 이름에 종류 접미사가 없으면 .service를 붙인 대상을 돌려준다.
// 종류가 비었으면 검사하지 않는다(필수 여부는 부르는 쪽이 본다).
func CheckTarget(t Target) (Target, []Problem) {
	var ps []Problem
	if t.Type != "journald" && (t.Kind != "" || t.Name != "") {
		ps = append(ps, problem("target.kind", "only_for_journald", "target.kind and target.name are only for journald"))
	}
	if hasControl(t.Path) {
		ps = append(ps, problem("target.path", "control_characters", "target.path must not contain control characters"))
	}
	switch t.Type {
	case "file":
		switch {
		case t.Path == "":
			ps = append(ps, problem("target.path", "required", "target.path must be one absolute file path"))
		case !filepath.IsAbs(t.Path):
			ps = append(ps, problem("target.path", "path_not_absolute", "target.path must be an absolute path"))
		case strings.ContainsAny(t.Path, "*?["):
			ps = append(ps, problem("target.path", "wildcard_not_allowed", "target.path must be one absolute file path"))
		}
	case "file_pattern":
		if code, msg := checkPattern(t.Path); code != "" {
			ps = append(ps, problem("target.path", code, "target.path %s", msg))
		}
	case "journald":
		if t.Path != "" {
			ps = append(ps, problem("target.path", "path_not_for_journald", "target.path is not used for journald; use target.kind and target.name"))
		}
		switch t.Kind {
		case "container":
			if !containerName.MatchString(t.Name) {
				ps = append(ps, problem("target.name", "name_invalid", "target.name %q must be one container name (letters, digits, _ . -)", t.Name))
			}
		case "unit":
			if !unitName.MatchString(t.Name) {
				ps = append(ps, problem("target.name", "name_invalid", "target.name %q must be one systemd unit name (no wildcards)", t.Name))
				break
			}
			if !hasUnitSuffix(t.Name) {
				t.Name += ".service"
			}
		default:
			ps = append(ps, problem("target.kind", "kind_invalid", "target.kind %q must be container or unit", t.Kind))
		}
	case "":
	default:
		ps = append(ps, problem("target.type", "type_invalid", "target.type %q must be file, file_pattern or journald", t.Type))
	}
	return t, ps
}

// CheckFormat은 형식과 새 이벤트 시작 규칙을 검사하고 규칙을 컴파일해 돌려준다. Go regexp는 RE2 문법이라
// 입력 길이에 선형 시간으로 돌아 규칙 하나가 읽기를 붙잡지 않는다. 형식이 비었으면 검사하지 않는다.
func CheckFormat(typ, eventStart string) (*regexp.Regexp, []Problem) {
	switch typ {
	case "text", "json":
		if eventStart != "" {
			return nil, []Problem{problem("format.event_start", "only_for_multiline", "format.event_start is only for multiline")}
		}
	case "multiline":
		if eventStart == "" {
			return nil, []Problem{problem("format.event_start", "required", "format.event_start is required for multiline")}
		}
		re, err := regexp.Compile(eventStart)
		if err != nil {
			p := problem("format.event_start", "pattern_invalid", "format.event_start: %v", err)
			var se *syntax.Error
			if errors.As(err, &se) {
				p.Expr = se.Expr
			}
			return nil, []Problem{p}
		}
		return re, nil
	case "":
	default:
		return nil, []Problem{problem("format.type", "type_invalid", "format.type %q must be text, json or multiline", typ)}
	}
	return nil, nil
}

// checkPattern은 파일명 규칙을 검사한다(계약 2.8절 file_pattern, Q02-06). 폴더는 고정 경로이고
// 이름 부분에만 *와 ?를 쓴다. [ ]와 \는 받지 않는다. 문자 묶음과 escape까지 열면 규칙을 읽고
// 검사하기 어려워지고, 요구된 예(app-*.log)는 *와 ?로 충분하기 때문이다. 문제가 있으면 사유 코드와 문장을 준다.
func checkPattern(p string) (code, msg string) {
	switch {
	case p == "":
		return "required", "is required"
	case !filepath.IsAbs(p):
		return "path_not_absolute", "must be an absolute path"
	case filepath.Clean(p) != p:
		return "path_not_clean", "must be a clean absolute path (no .., // or trailing /)"
	}
	dir, name := filepath.Dir(p), filepath.Base(p)
	switch {
	case strings.ContainsAny(dir, `*?[]\`):
		return "wildcard_in_folder", "may use * and ? only in the file name, not in the folder (Q02-06)"
	case strings.ContainsAny(name, `[]\`):
		return "wildcard_not_supported", "may use only * and ? as wildcards"
	case !strings.ContainsAny(name, "*?"):
		return "pattern_without_wildcard", "has no * or ?; use target.type file for one file"
	}
	if _, err := filepath.Match(name, ""); err != nil {
		return "pattern_invalid", err.Error()
	}
	return "", ""
}

func hasUnitSuffix(name string) bool {
	for _, s := range unitSuffixes {
		if strings.HasSuffix(name, s) && len(name) > len(s) {
			return true
		}
	}
	return false
}
