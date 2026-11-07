//go:build !(js && wasm)

// logdock-rules는 WebAssembly(GOOS=js GOARCH=wasm)로만 빌드해 조회·관리 API가 불러 쓴다. main_wasm.go를 본다.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "logdock-rules is built for WebAssembly: GOOS=js GOARCH=wasm go build ./cmd/logdock-rules")
	os.Exit(2)
}
