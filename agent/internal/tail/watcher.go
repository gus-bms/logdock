package tail

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"time"
)

// Watcher는 폴더 하나에서 이름 규칙에 맞는 파일을 모두 따라 읽는다(file_pattern, Q02-06).
//
// 파일은 이름이 아니라 장치·inode로 구분한다. 그래서 규칙 안에서 이름이 바뀐 파일은 같은 파일로
// 이어 읽고, 규칙 밖으로 이름이 바뀌었거나 지워진 파일은 마저 읽은 뒤 놓는다. 파일마다 따로
// 읽으며 파일 사이의 순서는 없다.
//
// 하위 폴더와 심볼릭 링크는 따라가지 않는다. 하위 폴더는 따로 등록하기로 했고(Q02-06), 링크는
// 폴더 밖 파일을 가리키거나 같은 파일을 두 번 읽게 할 수 있기 때문이다.
//
// 열린 파일 수를 묶으려고, 다 읽고 IdleClose 동안 조용한 파일은 닫아 둔다. 폴더를 훑다가 크기나
// 수정 시각이 바뀐 것이 보이면 다시 열고, 같은 파일인지 앞부분으로 확인한 뒤 이어 읽는다.
type Watcher struct {
	dir  string // 고정 폴더
	rule string // 이름 부분 규칙. *와 ?만 쓴다(설정 검사에서 막는다)
	opt  Options

	files map[FileID]*watched
	order []FileID // 처음 본 순서. 읽기 예산이 모자랄 때 이 순서로 차례를 돌린다
	next  int      // 다음 Poll에서 먼저 읽을 order 위치

	scanned  bool // 폴더 목록을 한 번 이상 봤다
	resumed  bool // 저장한 상태에서 다시 시작했다
	sameRule bool // 저장한 상태를 같은 규칙으로 만들었다
	// resumedUnsure는 저장할 때 따라가지 못한 파일이 있었다는 뜻이다(Resume.Unsure).
	resumedUnsure bool
	lastScan      time.Time
	full          bool // 마지막 탐색에서 MaxFiles에 닿았다
	waiting       bool // 열 자리가 없어 아직 읽지 못한 파일이 있다

	// unsure는 폴더 목록에서 봤지만 따라가기 시작하지 못한 파일(한도, 열기 오류)과 처음 봤을 때
	// 정한 시작 종류다. 나중에 따라갈 때 그 종류를 쓴다.
	unsure map[FileID]BoundaryKind

	// left는 이번 Poll에서 놓은 파일의 이름과 앞부분 해시다. 놓은 파일의 마지막 기록에도
	// 경로와 재시작 위치를 붙일 수 있게, 다음 Poll까지만 둔다.
	left map[FileID]leftFile
}

// watched는 따라가는 파일 하나다. f가 nil이면 닫아 둔 상태다.
type watched struct {
	tracked
	name  string
	gone  bool      // 규칙에 맞는 이름으로 더는 보이지 않는다. 마저 읽고 놓는다
	wake  bool      // 닫아 둔 사이 크기나 수정 시각이 바뀌었다. 다시 연다
	mtime time.Time // 닫아 둘 때의 수정 시각
	// saved는 재시작 뒤 아직 열어 보지 않은 파일의 저장한 앞부분 해시다. 처음 열 때 같은
	// 파일인지 확인하고 지운다.
	saved *Position
}

type leftFile struct {
	name string
	head head
}

// Saved는 재시작 뒤 이어 읽는 데 필요한 파일 하나의 상태다.
type Saved struct {
	Position
	Name string // 폴더 안 이름
	// Size는 마지막으로 본 크기다. 재시작 때 파일이 없으면 덜 읽은 바이트가 있었는지 본다.
	Size int64
}

// Resume은 Watcher를 저장한 상태에서 다시 시작하는 값이다.
type Resume struct {
	Files []Saved
	// SameRule은 저장할 때와 이름 규칙이 같다는 뜻이다. 같으면 상태에 없는 파일은 마지막으로
	// 폴더를 본 뒤에 생긴 것이므로 처음부터 읽는다. 규칙이 바뀌었으면 새로 규칙에 든 파일이
	// 언제 생겼는지 모르므로 발견한 때의 끝부터 읽는다(D02, AG-07).
	SameRule bool
	// Unsure는 저장할 때 폴더에서 봤지만 따라가지 못한 파일(한도, 열기 오류)이 있었다는 뜻이다.
	// 그 파일들도 언제 생겼는지 모르므로 상태에 없는 파일은 끝부터 읽는다.
	Unsure bool
}

// NewWatcher는 pattern(폴더 경로와 이름 규칙)을 따라 읽는 Watcher를 만든다. 첫 Poll 전에는
// 폴더를 읽지 않는다.
func NewWatcher(pattern string, opt Options) *Watcher {
	opt.setDefaults()
	return &Watcher{dir: filepath.Dir(pattern), rule: filepath.Base(pattern), opt: opt, files: map[FileID]*watched{}}
}

// Restore는 첫 Poll 전에 저장해 둔 상태를 넘겨 재시작 뒤 이어 읽게 한다. 부르지 않으면 최초
// 연결로 보고 이미 있는 파일은 끝에서 시작한다(D02).
func (w *Watcher) Restore(r Resume) {
	w.resumed, w.sameRule, w.resumedUnsure = true, r.SameRule, r.Unsure
	for _, s := range r.Files {
		if w.files[s.File] != nil {
			continue
		}
		p := s.Position
		w.add(&watched{tracked: tracked{id: s.File, offset: s.Offset, lastSize: s.Size}, name: s.Name, saved: &p})
	}
}

// Poll은 지난번 뒤로 붙은 바이트와 그 사이 생긴 경계를 돌려준다. 파일 하나를 읽지 못해도 나머지
// 파일은 읽고, 그때까지 모은 Chunk와 오류를 함께 돌려준다.
func (w *Watcher) Poll() ([]Chunk, error) {
	var out []Chunk
	var errs []error
	w.left = nil
	now := w.opt.Now()
	if !w.scanned || now.Sub(w.lastScan) >= w.opt.ScanInterval {
		w.lastScan = now
		if err := w.scan(&out); err != nil {
			errs = append(errs, err)
		}
	}
	if err := w.openWaiting(&out); err != nil {
		errs = append(errs, err)
	}
	// 읽기 예산은 Poll 한 번에 모든 파일을 합친 값이다. 쏟아지는 파일 하나가 다른 파일을
	// 굶기지 않게 먼저 읽는 파일을 Poll마다 바꾼다.
	budget := w.opt.MaxReadBytes
	for _, id := range w.rotated() {
		c := w.files[id]
		if c == nil || c.f == nil {
			continue
		}
		n, err := w.readOne(&out, c, budget)
		budget -= n
		if err != nil {
			errs = append(errs, err)
		}
	}
	w.next++
	return out, errors.Join(errs...)
}

// rotated는 order를 next부터 돌린 사본이다.
func (w *Watcher) rotated() []FileID {
	n := len(w.order)
	out := make([]FileID, 0, n)
	for i := range n {
		out = append(out, w.order[(w.next+i)%n])
	}
	return out
}

// scan은 폴더 목록을 읽어 처음 보는 파일을 따라가기 시작하고, 이름이 바뀌었거나 사라진 파일을
// 표시한다.
func (w *Watcher) scan(out *[]Chunk) error {
	entries, err := os.ReadDir(w.dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) && !w.scanned {
			// 처음 볼 때 폴더가 없었다. 나중에 생기는 파일은 연결 뒤에 만들어진 것이므로
			// 처음부터 읽는다.
			w.scanned = true
		}
		return err
	}
	type entry struct {
		name  string
		size  int64
		mtime time.Time
	}
	present := map[FileID]entry{}
	var fresh []FileID // 처음 보는 파일. ReadDir가 이름순으로 주므로 이름순이다
	var others []fs.DirEntry
	for _, e := range entries {
		if !e.Type().IsRegular() {
			continue // 하위 폴더, 심볼릭 링크, 장치 파일은 보지 않는다
		}
		if ok, _ := filepath.Match(w.rule, e.Name()); !ok {
			others = append(others, e)
			continue
		}
		fi, err := e.Info()
		if err != nil {
			continue // 그 사이 지워졌다
		}
		id, ok := fileIDOf(fi)
		if !ok {
			return errNoFileID
		}
		present[id] = entry{e.Name(), fi.Size(), fi.ModTime()}
		if w.files[id] == nil {
			fresh = append(fresh, id)
		}
	}

	var errs []error
	for _, id := range slices.Clone(w.order) {
		c := w.files[id]
		if e, ok := present[id]; ok {
			c.name, c.gone = e.name, false
			if c.f == nil && (e.size != c.lastSize || !e.mtime.Equal(c.mtime)) {
				c.wake = true
			}
			continue
		}
		if c.gone {
			continue
		}
		c.gone = true
		if c.f == nil {
			// 열린 파일은 Poll에서 마저 읽고 놓는다(leaveIfDone). 닫아 둔 파일은 여기서 찾아본다.
			if err := w.findMoved(out, c, others); err != nil {
				errs = append(errs, err)
			}
		}
	}

	unsure := map[FileID]BoundaryKind{}
	w.full = false
	for _, id := range fresh {
		kind := w.startKind(id)
		if len(w.files) >= w.opt.MaxFiles {
			w.full = true
			unsure[id] = kind
			continue
		}
		if err := w.adopt(out, present[id].name, kind); err != nil {
			errs = append(errs, err)
			unsure[id] = kind
		}
	}
	w.unsure = unsure
	w.scanned = true
	return errors.Join(errs...)
}

// startKind는 처음 보는 파일을 어디서부터 읽을지 정한다(D02, AG-07).
//   - 최초 연결 때 이미 있던 파일: 끝에서(InitialTail)
//   - 연결 뒤 폴더 목록에 새로 나타난 파일: 처음부터(NewFileHead)
//   - 언제 생겼는지 모르는 파일: 발견한 때의 끝에서(NewFileTail). 규칙을 바꾼 뒤 처음 보는 파일,
//     따라가지 못했던 파일이 남은 채 저장한 상태에서 다시 시작했을 때가 그렇다
func (w *Watcher) startKind(id FileID) BoundaryKind {
	if k, ok := w.unsure[id]; ok {
		if k == InitialTail {
			// 최초 연결 때 있던 파일인데 그때 끝 위치를 확정하지 못했다. 그 사이 붙은 내용이
			// 연결 뒤 것인지 가를 수 없으므로 지금 끝에서 시작한다.
			return NewFileTail
		}
		return k
	}
	switch {
	case !w.scanned && !w.resumed:
		return InitialTail
	case !w.scanned && (!w.sameRule || w.resumedUnsure):
		return NewFileTail
	}
	return NewFileHead
}

// adopt는 처음 보는 파일을 kind에 맞는 위치에서 따라가기 시작한다.
func (w *Watcher) adopt(out *[]Chunk, name string, kind BoundaryKind) error {
	f, fi, err := openRegular(filepath.Join(w.dir, name))
	if errors.Is(err, fs.ErrNotExist) {
		return nil // 그 사이 지워졌거나 이름이 바뀌었다. 다음 탐색에서 다시 본다
	}
	if err != nil {
		return err
	}
	id, ok := fileIDOf(fi)
	if !ok {
		f.Close()
		return errNoFileID
	}
	if w.files[id] != nil {
		return f.Close() // 그 사이 이름이 바뀌어 들어온, 이미 따라가는 파일이다
	}
	start := int64(0)
	if kind != NewFileHead {
		start = fi.Size()
	}
	t, err := newTracked(f, fi, start, w.opt.FingerprintBytes)
	if err != nil {
		f.Close()
		return err
	}
	ch := Chunk{File: id, Offset: start, Boundary: kind}
	if kind != NewFileHead {
		if ch.AtLineStart, err = endsWithNewline(f, start); err != nil {
			f.Close()
			return err
		}
	}
	if kind == NewFileTail {
		ch.SkippedBytes = start
	}
	c := &watched{tracked: *t, name: name}
	c.lastDataAt = w.opt.Now()
	w.add(c)
	*out = append(*out, ch)
	if w.OpenFiles() > w.opt.MaxOpen {
		// 열 자리가 없다. 시작 위치만 정해 두고 닫았다가 자리가 나면 연다(openWaiting).
		c.mtime = fi.ModTime()
		return w.closeFile(c)
	}
	return nil
}

// findMoved는 닫아 둔 파일이 규칙에서 빠졌을 때 같은 폴더의 다른 이름에서 찾는다. 이름만
// 바뀌었으면 다시 열어 마저 읽고 놓는다. 찾지 못하면 놓는다.
func (w *Watcher) findMoved(out *[]Chunk, c *watched, others []fs.DirEntry) error {
	for _, e := range others {
		fi, err := e.Info()
		if err != nil {
			continue
		}
		if id, ok := fileIDOf(fi); !ok || id != c.id {
			continue
		}
		f, fi, err := openRegular(filepath.Join(w.dir, e.Name()))
		if err != nil {
			break // 그 사이 또 바뀌었거나 읽을 수 없다. 사라진 것으로 본다
		}
		same, err := c.sameContent(f)
		if id, ok := fileIDOf(fi); err != nil || !same || !ok || id != c.id {
			f.Close() // 같은 번호의 다른 파일이다
			break
		}
		c.name = e.Name()
		return w.attach(out, c, f, fi, true)
	}
	if c.lastSize > c.offset {
		// 덜 읽은 바이트가 있던 파일이 사라졌다(열 자리를 기다리던 파일, 재시작 전 덜 읽은 파일).
		// 그 뒤 더 쓰였을 수 있어 잃은 크기는 모른다.
		*out = append(*out, Chunk{File: c.id, Offset: c.offset, Boundary: GoneBeforeRead, SkippedBytes: Unknown})
	}
	return w.forget(out, c)
}

// openWaiting은 닫아 둔 파일 가운데 바뀌었거나 덜 읽었거나 재시작 뒤 아직 확인하지 않은 파일을
// 자리가 있는 만큼 다시 연다.
func (w *Watcher) openWaiting(out *[]Chunk) error {
	w.waiting = false
	open := w.OpenFiles()
	var errs []error
	for _, id := range slices.Clone(w.order) {
		c := w.files[id]
		if c == nil || c.f != nil || c.gone || !(c.wake || c.saved != nil || c.lastSize > c.offset) {
			continue
		}
		if open >= w.opt.MaxOpen {
			w.waiting = true
			break
		}
		if err := w.reopen(out, c); err != nil {
			errs = append(errs, err)
		}
		if c.f != nil {
			open++
		}
	}
	return errors.Join(errs...)
}

// reopen은 닫아 둔 파일을 이름으로 다시 연다.
func (w *Watcher) reopen(out *[]Chunk, c *watched) error {
	f, fi, err := openRegular(filepath.Join(w.dir, c.name))
	if errors.Is(err, fs.ErrNotExist) {
		return nil // 다음 탐색에서 사라진 것으로 본다
	}
	if err != nil {
		return err
	}
	if id, ok := fileIDOf(fi); !ok || id != c.id {
		return f.Close() // 그 이름이 이제 다른 파일이다. 다음 탐색에서 둘 다 다시 본다
	}
	same, err := c.sameContent(f)
	if err != nil {
		f.Close()
		return err
	}
	return w.attach(out, c, f, fi, same)
}

// attach는 다시 연 파일을 이어 읽게 한다. 같은 파일이 아니거나 잘렸으면 처음부터 읽는다.
func (w *Watcher) attach(out *[]Chunk, c *watched, f *os.File, fi os.FileInfo, same bool) error {
	size := fi.Size()
	switch {
	case !same && c.saved != nil:
		// 재시작 전과 장치·inode는 같지만 다른 파일이다(지운 뒤 번호가 다시 쓰였다). 옛 파일의
		// 남은 부분은 잃었고 크기는 모른다.
		*out = append(*out, Chunk{File: c.id, Boundary: IdentityReused, SkippedBytes: Unknown})
		c.offset = 0
	case !same || size < c.offset:
		// 닫아 둔 사이 잘렸거나(copytruncate) 처음부터 다시 쓰였다.
		*out = append(*out, Chunk{File: c.id, Boundary: Truncated, SkippedBytes: Unknown})
		c.offset = 0
	}
	c.f, c.saved, c.wake = f, nil, false
	c.lastSize, c.lastDataAt = size, w.opt.Now()
	return c.loadHead(size, w.opt.FingerprintBytes)
}

// readOne은 열린 파일 하나를 읽고, 다 읽은 파일을 닫아 두거나 놓는다.
func (w *Watcher) readOne(out *[]Chunk, c *watched, budget int) (int, error) {
	rewritten, err := c.checkRewrite(w.opt.FingerprintBytes)
	if rewritten {
		// 잘리기 직전에 쓰였지만 아직 읽지 못한 바이트는 잃었다. 얼마인지는 모른다.
		*out = append(*out, Chunk{File: c.id, Offset: 0, Boundary: Truncated, SkippedBytes: Unknown})
	}
	if err != nil {
		return 0, err
	}
	n, err := c.drain(out, budget, w.opt.Now)
	if err != nil {
		return n, err
	}
	fi, err := c.f.Stat()
	if err != nil {
		return n, err
	}
	now := w.opt.Now()
	atEOF := c.offset >= fi.Size()
	if c.gone {
		return n, w.leaveIfDone(out, c, fi, atEOF, now)
	}
	if atEOF && now.Sub(c.lastDataAt) >= w.opt.IdleClose {
		// 다 읽었고 한동안 조용하다. 닫아 두고, 폴더를 훑다가 바뀐 것이 보이면 다시 연다.
		c.lastSize, c.mtime = fi.Size(), fi.ModTime()
		return n, w.closeFile(c)
	}
	return n, nil
}

// leaveIfDone은 규칙에서 빠진 열린 파일을 다 읽었으면 놓는다. 지워진 파일을 덜 읽은 채
// MaxHoldDeleted가 지나면 디스크 공간을 돌려주려고 남은 바이트를 잃은 것으로 알리고 놓는다.
func (w *Watcher) leaveIfDone(out *[]Chunk, c *watched, fi os.FileInfo, atEOF bool, now time.Time) error {
	deleted := linkCount(fi) == 0
	if deleted && c.deletedAt.IsZero() {
		c.deletedAt = now
	}
	if deleted && !atEOF && now.Sub(c.deletedAt) >= w.opt.MaxHoldDeleted {
		*out = append(*out, Chunk{File: c.id, Offset: c.offset, Boundary: GoneBeforeRead, SkippedBytes: fi.Size() - c.offset})
		return w.forget(out, c)
	}
	// 앱은 로그를 다시 열기 전까지 옛 파일에 더 쓸 수 있다. 지워진 파일은 디스크 공간을 붙잡으므로
	// RotateGrace만, 이름만 바뀌어 남은 파일은 IdleClose만큼 조용하면 놓는다.
	quiet := w.opt.IdleClose
	if deleted {
		quiet = w.opt.RotateGrace
	}
	if atEOF && now.Sub(c.lastDataAt) >= quiet {
		return w.forget(out, c)
	}
	return nil
}

// forget은 파일을 놓는다. 받는 쪽이 이 파일의 남은 줄을 끝내도록 End를 낸다.
func (w *Watcher) forget(out *[]Chunk, c *watched) error {
	var err error
	if c.f != nil {
		err = w.closeFile(c)
	}
	n, sum, _ := w.Head(c.id)
	if w.left == nil {
		w.left = map[FileID]leftFile{}
	}
	w.left[c.id] = leftFile{name: c.name, head: head{n: n, sum: sum}}
	delete(w.files, c.id)
	w.order = slices.DeleteFunc(w.order, func(id FileID) bool { return id == c.id })
	*out = append(*out, Chunk{File: c.id, Offset: c.offset, End: true})
	return err
}

func (w *Watcher) closeFile(c *watched) error {
	err := c.f.Close()
	c.f = nil
	return err
}

func (w *Watcher) add(c *watched) {
	w.files[c.id] = c
	w.order = append(w.order, c.id)
}

// sameContent는 다시 연 파일의 앞부분이 기억한 것과 같은지 본다.
func (c *watched) sameContent(f *os.File) (bool, error) {
	if c.saved != nil {
		return sameHead(f, *c.saved)
	}
	if len(c.head) == 0 {
		return true, nil
	}
	buf := make([]byte, len(c.head))
	n, err := f.ReadAt(buf, 0)
	if err != nil && !errors.Is(err, io.EOF) {
		return false, err
	}
	return n == len(buf) && bytes.Equal(buf, c.head), nil
}

// Head는 id 파일의 앞부분 길이와 해시다. 기록마다 재시작 위치에 함께 둔다.
func (w *Watcher) Head(id FileID) (int, [sha256.Size]byte, bool) {
	if c := w.files[id]; c != nil {
		if c.saved != nil {
			return c.saved.HeadLen, c.saved.HeadSum, true
		}
		return len(c.head), sha256.Sum256(c.head), true
	}
	if l, ok := w.left[id]; ok {
		return l.head.n, l.head.sum, true
	}
	return 0, [sha256.Size]byte{}, false
}

// Path는 id 파일의 지금 경로다. 이번 Poll에서 놓은 파일은 놓을 때의 경로다.
func (w *Watcher) Path(id FileID) string {
	if c := w.files[id]; c != nil {
		return filepath.Join(w.dir, c.name)
	}
	if l, ok := w.left[id]; ok {
		return filepath.Join(w.dir, l.name)
	}
	return ""
}

// Files는 따라가는 파일의 상태다. 재시작 상태를 저장할 때 쓴다. Offset은 읽은 위치이므로
// 부르는 쪽이 이벤트로 확정한 위치로 바꿔 저장해야 한다(AG-12).
func (w *Watcher) Files() []Saved {
	out := make([]Saved, 0, len(w.order))
	for _, id := range w.order {
		c := w.files[id]
		n, sum, _ := w.Head(id)
		out = append(out, Saved{
			Position: Position{File: id, Offset: c.offset, HeadLen: n, HeadSum: sum},
			Name:     c.name,
			Size:     max(c.lastSize, c.offset),
		})
	}
	return out
}

// Scanned는 폴더 목록을 한 번 이상 봤는지다. 보기 전에는 최초 시작 위치가 정해지지 않았다.
func (w *Watcher) Scanned() bool { return w.scanned }

// Unsure는 폴더에서 봤지만 따라가지 못한 파일이 있는지다. 재시작 상태에 함께 저장한다.
func (w *Watcher) Unsure() bool { return len(w.unsure) > 0 }

// Limited는 한도 때문에 따라가지 못하거나 아직 읽지 못한 파일이 있는지다.
func (w *Watcher) Limited() bool { return w.full || w.waiting }

// OpenFiles는 지금 열어 둔 파일 수다.
func (w *Watcher) OpenFiles() int {
	n := 0
	for _, c := range w.files {
		if c.f != nil {
			n++
		}
	}
	return n
}

// Close는 열어 둔 파일을 모두 닫는다.
func (w *Watcher) Close() error {
	var errs []error
	for _, c := range w.files {
		if c.f != nil {
			errs = append(errs, w.closeFile(c))
		}
	}
	return errors.Join(errs...)
}
