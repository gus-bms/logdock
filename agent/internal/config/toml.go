package config

import (
	"bytes"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// table은 TOML 표 하나다. 값은 string, int64, bool 가운데 하나다.
type table map[string]any

var (
	bareKey   = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	tableHead = regexp.MustCompile(`^\[([A-Za-z0-9_-]+)\]$`)
	integer   = regexp.MustCompile(`^[+-]?(0|[1-9](_?[0-9])*)$`)
)

// parseTOML은 LogDock 설정에 쓰는 TOML의 일부만 읽는다. 주석, 한 단계 표 머리([target]),
// key = 값(기본 문자열 "...", 리터럴 문자열 '...', 정수, 참거짓)만 받고 그 밖의 문법(배열,
// 인라인 표, 점 키, 여러 줄 문자열, 실수, 날짜)은 오류로 거절한다. 설정은 중앙이 만들어
// 내려주므로 이 범위로 충분하고, 키를 다루는 운영 서버 프로그램에 외부 라이브러리를 들이지
// 않으려고 직접 읽는다. 결과의 ""는 표 머리 앞의 최상위 값이다.
func parseTOML(src []byte) (map[string]table, error) {
	src = bytes.TrimPrefix(src, []byte("\xef\xbb\xbf")) // UTF-8 BOM
	if !utf8.Valid(src) {
		return nil, fmt.Errorf("not valid UTF-8")
	}
	doc := map[string]table{"": {}}
	cur := ""
	for i, raw := range strings.Split(string(src), "\n") {
		n := i + 1
		line := strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") {
			head, rest := line, ""
			if j := strings.Index(line, "]"); j >= 0 {
				head, rest = line[:j+1], strings.TrimSpace(line[j+1:])
			}
			m := tableHead.FindStringSubmatch(head)
			if m == nil || (rest != "" && !strings.HasPrefix(rest, "#")) {
				return nil, fmt.Errorf("line %d: unsupported table header %q", n, line)
			}
			if _, dup := doc[m[1]]; dup {
				return nil, fmt.Errorf("line %d: table [%s] defined twice", n, m[1])
			}
			cur = m[1]
			doc[cur] = table{}
			continue
		}
		key, rest, ok := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !ok || !bareKey.MatchString(key) {
			return nil, fmt.Errorf("line %d: expected key = value", n)
		}
		v, tail, err := parseValue(strings.TrimSpace(rest))
		if err != nil {
			return nil, fmt.Errorf("line %d: %s: %w", n, key, err)
		}
		if tail = strings.TrimSpace(tail); tail != "" && !strings.HasPrefix(tail, "#") {
			return nil, fmt.Errorf("line %d: %s: unexpected %q after the value", n, key, tail)
		}
		if _, dup := doc[cur][key]; dup {
			return nil, fmt.Errorf("line %d: %s set twice", n, key)
		}
		doc[cur][key] = v
	}
	return doc, nil
}

// parseValue는 값 하나를 읽고 뒤에 남은 글자를 돌려준다.
func parseValue(s string) (any, string, error) {
	switch {
	case strings.HasPrefix(s, `"""`) || strings.HasPrefix(s, "'''"):
		return nil, "", fmt.Errorf("multi-line strings are not supported")
	case strings.HasPrefix(s, `"`):
		return parseBasicString(s[1:])
	case strings.HasPrefix(s, "'"):
		end := strings.IndexByte(s[1:], '\'')
		if end < 0 {
			return nil, "", fmt.Errorf("unterminated literal string")
		}
		return s[1 : 1+end], s[2+end:], nil
	}
	word, tail := s, ""
	if j := strings.IndexAny(s, " \t#"); j >= 0 {
		word, tail = s[:j], s[j:]
	}
	switch {
	case word == "true":
		return true, tail, nil
	case word == "false":
		return false, tail, nil
	case integer.MatchString(word):
		v, err := strconv.ParseInt(strings.ReplaceAll(word, "_", ""), 10, 64)
		if err != nil {
			return nil, "", fmt.Errorf("integer out of range")
		}
		return v, tail, nil
	}
	return nil, "", fmt.Errorf("unsupported value %q (only strings, integers and booleans)", word)
}

// parseBasicString은 여는 따옴표 뒤부터 기본 문자열을 읽는다.
func parseBasicString(s string) (any, string, error) {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '"':
			return b.String(), s[i+1:], nil
		case c == '\\':
			if i+1 >= len(s) {
				return nil, "", fmt.Errorf("unterminated escape")
			}
			i++
			switch s[i] {
			case 'b':
				b.WriteByte('\b')
			case 't':
				b.WriteByte('\t')
			case 'n':
				b.WriteByte('\n')
			case 'f':
				b.WriteByte('\f')
			case 'r':
				b.WriteByte('\r')
			case '"':
				b.WriteByte('"')
			case '\\':
				b.WriteByte('\\')
			case 'u', 'U':
				size := 4
				if s[i] == 'U' {
					size = 8
				}
				if i+size >= len(s) {
					return nil, "", fmt.Errorf("short unicode escape")
				}
				r, err := strconv.ParseUint(s[i+1:i+1+size], 16, 32)
				if err != nil || !utf8.ValidRune(rune(r)) {
					return nil, "", fmt.Errorf("bad unicode escape")
				}
				b.WriteRune(rune(r))
				i += size
			default:
				return nil, "", fmt.Errorf("unknown escape \\%c", s[i])
			}
		case c < 0x20 && c != '\t', c == 0x7f:
			return nil, "", fmt.Errorf("control character in string")
		default:
			b.WriteByte(c)
		}
	}
	return nil, "", fmt.Errorf("unterminated string")
}
