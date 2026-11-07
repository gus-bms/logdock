package rules

import (
	"reflect"
	"testing"
)

// 등록 API가 화면에 주는 사유 코드를 고정한다. 문장은 에이전트 오류에 쓰고 코드는 API가 쓴다.
func TestCheckTargetCodes(t *testing.T) {
	cases := []struct {
		in    Target
		codes []string
		name  string
	}{
		{Target{Type: "file", Path: "/var/app/order/app.log"}, nil, ""},
		{Target{Type: "file", Path: ""}, []string{"required"}, ""},
		{Target{Type: "file", Path: "var/app.log"}, []string{"path_not_absolute"}, ""},
		{Target{Type: "file", Path: "/var/app/*.log"}, []string{"wildcard_not_allowed"}, ""},
		{Target{Type: "file", Path: "/var/app/a\nb.log"}, []string{"control_characters"}, ""},
		{Target{Type: "file_pattern", Path: "/var/app/order/app-*.log"}, nil, ""},
		{Target{Type: "file_pattern", Path: "logs/app-*.log"}, []string{"path_not_absolute"}, ""},
		{Target{Type: "file_pattern", Path: "/var/app/../app-*.log"}, []string{"path_not_clean"}, ""},
		{Target{Type: "file_pattern", Path: "/var/*/app.log"}, []string{"wildcard_in_folder"}, ""},
		{Target{Type: "file_pattern", Path: "/var/app/app-[0-9].log"}, []string{"wildcard_not_supported"}, ""},
		{Target{Type: "file_pattern", Path: "/var/app/app.log"}, []string{"pattern_without_wildcard"}, ""},
		{Target{Type: "journald", Kind: "container", Name: "order-api"}, nil, "order-api"},
		{Target{Type: "journald", Kind: "unit", Name: "nginx"}, nil, "nginx.service"},
		{Target{Type: "journald", Kind: "unit", Name: "app-*"}, []string{"name_invalid"}, ""},
		{Target{Type: "journald", Kind: "container", Name: ""}, []string{"name_invalid"}, ""},
		{Target{Type: "journald", Kind: "host", Name: "x"}, []string{"kind_invalid"}, ""},
		{Target{Type: "journald", Path: "/var/log/x", Kind: "unit", Name: "nginx"}, []string{"path_not_for_journald"}, ""},
		{Target{Type: "file", Path: "/var/app.log", Kind: "unit"}, []string{"only_for_journald"}, ""},
		{Target{Type: "syslog"}, []string{"type_invalid"}, ""},
	}
	for _, tc := range cases {
		got, ps := CheckTarget(tc.in)
		var codes []string
		for _, p := range ps {
			codes = append(codes, p.Code)
		}
		if !reflect.DeepEqual(codes, tc.codes) {
			t.Errorf("%+v: codes %v, want %v", tc.in, codes, tc.codes)
		}
		if tc.name != "" && got.Name != tc.name {
			t.Errorf("%+v: name %q, want %q", tc.in, got.Name, tc.name)
		}
	}
}

func TestCheckFormatCodes(t *testing.T) {
	cases := []struct {
		typ, start string
		code       string
		expr       string
	}{
		{"text", "", "", ""},
		{"multiline", `^\d{4}-\d{2}-\d{2} `, "", ""},
		{"multiline", `(?i)^error`, "", ""},
		{"multiline", "", "required", ""},
		{"text", "^x", "only_for_multiline", ""},
		{"multiline", `^(\d{4}-`, "pattern_invalid", `^(\d{4}-`},
		{"multiline", `(?<=a)b`, "pattern_invalid", `(?<=a)b`},
		{"xml", "", "type_invalid", ""},
	}
	for _, tc := range cases {
		re, ps := CheckFormat(tc.typ, tc.start)
		switch {
		case tc.code == "" && len(ps) != 0:
			t.Errorf("%s %q: unexpected %+v", tc.typ, tc.start, ps)
		case tc.code == "":
			if tc.typ == "multiline" && re == nil {
				t.Errorf("%s %q: no compiled rule", tc.typ, tc.start)
			}
		case len(ps) != 1 || ps[0].Code != tc.code || ps[0].Expr != tc.expr:
			t.Errorf("%s %q: got %+v, want code %s expr %q", tc.typ, tc.start, ps, tc.code, tc.expr)
		}
	}
}
