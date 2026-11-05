//go:build unix

package tail

import (
	"os"
	"syscall"
)

// fileIDOf는 stat 결과에서 장치와 inode 번호를 꺼낸다.
func fileIDOf(fi os.FileInfo) (FileID, bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return FileID{}, false
	}
	return FileID{Dev: uint64(st.Dev), Ino: uint64(st.Ino)}, true
}

// linkCount는 파일을 가리키는 디렉터리 항목 수다. 0이면 열어 둔 사이에 지워진 파일이다.
func linkCount(fi os.FileInfo) uint64 {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 1
	}
	return uint64(st.Nlink)
}
