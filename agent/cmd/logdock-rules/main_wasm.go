//go:build js && wasm

// logdock-rules는 수집 대상·형식 검사(internal/rules의 CheckTarget·CheckFormat)를 WebAssembly로 내보낸다.
// 조회·관리 API(Node)가 불러 등록과 사전 검사를 에이전트와 같은 코드로 한다(계약 2.8절).
//
//	GOOS=js GOARCH=wasm go build -trimpath -ldflags='-s -w' -o rules.wasm ./cmd/logdock-rules
//
// 시간대 이름은 검사하지 않는다. WebAssembly 안에서는 시간대 자료 파일을 읽을 수 없어 API가 따로 본다.
package main

import (
	"encoding/json"
	"syscall/js"

	"github.com/gus-bms/logdock/agent/internal/rules"
)

type target struct {
	Type string `json:"type"`
	Path string `json:"path"`
	Kind string `json:"kind"`
	Name string `json:"name"`
}

type request struct {
	Target target `json:"target"`
	Format struct {
		Type       string `json:"type"`
		EventStart string `json:"event_start"`
	} `json:"format"`
}

type response struct {
	Target   target          `json:"target"`
	Problems []rules.Problem `json:"problems"`
	Error    string          `json:"error,omitempty"`
}

// check는 JSON 요청 하나를 받아 맞춘 수집 대상과 문제 목록을 JSON으로 돌려준다.
func check(_ js.Value, args []js.Value) any {
	var req request
	var res response
	if len(args) != 1 {
		res.Error = "want one JSON argument"
	} else if err := json.Unmarshal([]byte(args[0].String()), &req); err != nil {
		res.Error = err.Error()
	} else {
		t, ps := rules.CheckTarget(rules.Target(req.Target))
		_, fps := rules.CheckFormat(req.Format.Type, req.Format.EventStart)
		res.Target = target(t)
		res.Problems = append(append([]rules.Problem{}, ps...), fps...)
	}
	b, _ := json.Marshal(res)
	return string(b)
}

func main() {
	js.Global().Set("logdockCheckConnection", js.FuncOf(check))
	// 프로그램이 끝나면 내보낸 함수를 부를 수 없으므로 계속 살아 있게 둔다.
	select {}
}
