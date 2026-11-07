package gen

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// pools hold value lists made once from the seed. Their sizes and the
// Zipf skews decide how repetitive the logs are, which decides compression.
// N1 is tuned so that gzip -6 keeps about 5.8% of the bytes, matching the
// 2026-11-07 field measurement (plan section 3).
type pools struct {
	ips    []string
	uas    []string
	refs   []string
	hashes []string
	words  []string
	zIP    *rand.Zipf
	zUA    *rand.Zipf
	zRoute *rand.Zipf
	zID    *rand.Zipf
	zMsg   *rand.Zipf
}

func newPools(d *rand.Rand, r *rand.Rand) *pools {
	p := &pools{}
	for range 4000 {
		p.ips = append(p.ips, fmt.Sprintf("10.%d.%d.%d", d.IntN(64), d.IntN(256), 1+d.IntN(254)))
	}
	browsers := []string{
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%d.0.%d.%d Safari/537.36",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%d.0.%d.%d Safari/537.36",
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_%d like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.%d Mobile/15E148 Safari/604.%d",
		"Mozilla/5.0 (Linux; Android 15; SM-S9%02d) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%d.0.%d.0 Mobile Safari/537.36",
		"Mozilla/5.0 (Linux; Android 14; SM-A5%02d) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/%d.0 Chrome/%d.0.0.0 Mobile Safari/537.36",
	}
	for i := range 120 {
		b := browsers[i%len(browsers)]
		p.uas = append(p.uas, fmt.Sprintf(b, 120+d.IntN(20), d.IntN(7000), d.IntN(200)))
	}
	p.uas = append(p.uas, "curl/8.5.0", "kube-probe/1.31", "Googlebot/2.1 (+http://www.google.com/bot.html)", "Go-http-client/1.1")
	p.refs = []string{"-", "-", "-", "https://www.example.com/", "https://www.example.com/board/list.php", "https://m.example.com/", "https://www.example.com/shop/cart.php", "https://search.example.net/"}
	for range 64 {
		p.hashes = append(p.hashes, fmt.Sprintf("%08x", d.Uint32()))
	}
	p.words = []string{"신발", "가방", "원피스", "노트북", "이어폰", "shoes", "bag", "laptop", "coat", "watch", "선물", "할인"}
	p.zIP = rand.NewZipf(r, 1.4, 1, uint64(len(p.ips)-1))
	p.zUA = rand.NewZipf(r, 1.3, 1, uint64(len(p.uas)-1))
	p.zRoute = rand.NewZipf(r, 1.2, 1, uint64(len(routes)-1))
	p.zID = rand.NewZipf(r, 1.2, 1, 300_000)
	p.zMsg = rand.NewZipf(r, 1.1, 1, uint64(len(enMsgs)-1))
	return p
}

type route struct {
	method string
	path   string // %d id, %s hash or word
	static bool
}

var routes = []route{
	{"GET", "/index.php", false},
	{"GET", "/board/view.php?id=%d", false},
	{"GET", "/board/list.php?page=%d", false},
	{"GET", "/static/js/app.%s.js", true},
	{"GET", "/static/css/main.%s.css", true},
	{"GET", "/images/products/%d.jpg", true},
	{"GET", "/api/v1/products/%d", false},
	{"POST", "/api/v1/orders", false},
	{"GET", "/api/v1/orders/%d", false},
	{"GET", "/health", false},
	{"GET", "/shop/cart.php", false},
	{"POST", "/member/login.php", false},
	{"GET", "/search.php?q=%s&page=%d", false},
	{"POST", "/api/v1/payments/%d/approve", false},
	{"GET", "/favicon.ico", true},
	{"GET", "/admin/member_list.php?page=%d", false},
	{"PUT", "/api/v1/users/%d/profile", false},
	{"GET", "/robots.txt", true},
	{"DELETE", "/api/v1/cart/items/%d", false},
	{"GET", "/event/coupon.php?code=%s", false},
}

func (g *Generator) id() int { return int(g.p.zID.Uint64()) + 1 }

func (g *Generator) routePath(rt route) string {
	var b strings.Builder
	tmpl := rt.path
	for i := 0; i < len(tmpl); i++ {
		if tmpl[i] != '%' || i+1 >= len(tmpl) {
			b.WriteByte(tmpl[i])
			continue
		}
		i++
		switch tmpl[i] {
		case 'd':
			b.WriteString(strconv.Itoa(g.id()))
		case 's':
			if strings.Contains(tmpl, "q=") {
				b.WriteString(urlEscape(g.p.words[g.r.IntN(len(g.p.words))]))
			} else {
				b.WriteString(g.p.hashes[g.r.IntN(len(g.p.hashes))])
			}
		}
	}
	return b.String()
}

// sizeOf gives a stable response size per path.
func sizeOf(path string, static bool) int {
	h := uint32(2166136261)
	for i := 0; i < len(path); i++ {
		h ^= uint32(path[i])
		h *= 16777619
	}
	if static {
		return 1500 + int(h%150_000)
	}
	return 90 + int(h%4000)
}

func urlEscape(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < 0x80 && (c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9') {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}

func (g *Generator) status(rt route) int {
	x := g.r.Float64()
	switch {
	case rt.static && x < 0.25:
		return 304
	case x < 0.86:
		return 200
	case x < 0.90:
		return 302
	case x < 0.965:
		return 404
	case x < 0.975:
		return 499
	case x < 0.99:
		return 500
	default:
		return 502
	}
}

// nginxEvent makes an access log line in the combined format plus $request_time.
func (g *Generator) nginxEvent(e *Event, needle string) {
	rt := routes[g.p.zRoute.Uint64()]
	path := g.routePath(rt)
	if needle != "" {
		path += "?note=" + urlEscape(needle)
	}
	st := g.status(rt)
	bytes := 0
	switch {
	case st == 304 || st == 499:
	case st >= 300:
		bytes = []int{154, 162, 568, 157}[st%4]
	default:
		// The same resource usually returns the same size.
		bytes = sizeOf(path, rt.static)
		if !rt.static && g.r.IntN(4) == 0 {
			bytes += g.r.IntN(64)
		}
	}
	// Visitors make several requests in a row (page, then its assets), so
	// the same address and agent repeat nearby.
	if e.Src.client < 0 || g.r.IntN(100) < 28 {
		e.Src.client = int(g.p.zIP.Uint64())
	}
	ip := g.p.ips[e.Src.client]
	ua := g.p.uas[e.Src.client%len(g.p.uas)]
	ref := g.p.refs[e.Src.client%len(g.p.refs)]
	rtime := 0.0
	switch x := g.r.IntN(100); {
	case rt.static || x < 55:
		rtime = float64(g.r.IntN(3)) / 1000
	case x < 95:
		rtime = float64(3+g.r.IntN(120)) / 1000
	default:
		rtime = float64(120+g.r.IntN(3000)) / 1000
	}
	local := e.RefTime.In(kst).Format("02/Jan/2006:15:04:05 -0700")
	e.Body = fmt.Sprintf(`%s - - [%s] "%s %s HTTP/1.1" %d %d "%s" "%s" %.3f`,
		ip, local, rt.method, path, st, bytes, ref, ua, rtime)
	// nginx access logs carry no level (SD-09: unreadable level is UNKNOWN).
	e.Level, e.LevelRaw = "UNKNOWN", ""
	// Access log time has whole seconds; the stored reference keeps them.
	e.RefTime = e.RefTime.Truncate(time.Second)
	if g.r.IntN(1000) == 0 {
		e.ParseStatus = "failed"
		e.Fields = map[string]any{}
		e.Body = e.Body[:len(e.Body)/2]
		return
	}
	e.ParseStatus = "ok"
	e.Fields = map[string]any{
		"remote_addr": ip,
		"http": map[string]any{
			"method": rt.method, "path": path, "status": st, "bytes": bytes,
			"referer": ref, "user_agent": ua,
		},
		"request_time": rtime,
	}
}

var enMsgs = []string{
	"request completed in %dms",
	"cache miss key=product:%d",
	"db query took %dms rows=%d",
	"payment timeout after %dms order=%d",
	"user %d logged in",
	"order %d created",
	"retrying upstream call attempt=%d",
	"session expired user=%d",
	"failed to send push notification device=%d",
	"inventory sync finished items=%d",
	"slow request path=/api/v1/orders/%d took %dms",
	"connection reset by peer upstream=%d",
}

var koMsgs = []string{
	"결제 승인 실패 주문번호=%d 사유=카드사 응답 없음",
	"결제 요청 처리 완료 금액=%d원",
	"회원 %d 로그인 성공",
	"쿠폰 적용 실패 쿠폰번호=%d",
	"배송 상태 변경 주문=%d 상태=배송중",
	"포인트 적립 완료 회원=%d 포인트=%d",
	"외부 API 응답 지연 %dms",
	"환불 요청 접수 주문=%d",
	"재고 부족 상품=%d",
	"알림톡 발송 실패 템플릿=%d",
}

func (g *Generator) message(needle string) string {
	var tmpl string
	if g.r.IntN(10) < 3 {
		tmpl = koMsgs[g.r.IntN(len(koMsgs))]
	} else {
		tmpl = enMsgs[g.p.zMsg.Uint64()]
	}
	n := strings.Count(tmpl, "%d")
	args := make([]any, n)
	for i := range args {
		args[i] = g.id()
	}
	msg := fmt.Sprintf(tmpl, args...)
	if needle != "" {
		msg += " " + needle
	}
	return msg
}

func (g *Generator) stack() string {
	var b strings.Builder
	b.WriteString("\nError: upstream request failed")
	for i := range 5 + g.r.IntN(11) {
		fmt.Fprintf(&b, "\n    at %s (/app/src/%s.js:%d:%d)",
			[]string{"handle", "process", "callUpstream", "Object.<anonymous>", "next"}[i%5],
			[]string{"service/payment", "service/order", "lib/http", "routes/api"}[g.r.IntN(4)],
			10+g.r.IntN(400), 1+g.r.IntN(60))
	}
	return b.String()
}

// textEvent makes T1 or T2 lines (Q08 plan section 4).
func (g *Generator) textEvent(e *Event, needle string) {
	lvl := g.pickLevel()
	local := e.RefTime.In(kst)
	e.RefTime = e.RefTime.Truncate(time.Second)
	msg := g.message(needle)
	if g.r.IntN(50) == 0 {
		msg += g.stack()
	}
	raw := strings.ToLower(lvl)
	if raw == "fatal" {
		raw = "error"
	}
	switch e.Src.Format {
	case T1:
		e.Body = fmt.Sprintf("%s %s [request-id: r-%06x]: %s",
			local.Format("2006-01-02 15:04:05"), raw, g.r.IntN(1<<24), msg)
	case T2:
		ampm := "오전"
		h := local.Hour()
		if h >= 12 {
			ampm = "오후"
		}
		if h%12 == 0 {
			h = 12
		} else {
			h %= 12
		}
		stamp := fmt.Sprintf("%d. %d. %d. %s %d:%02d:%02d", local.Year(), int(local.Month()), local.Day(),
			ampm, h, local.Minute(), local.Second())
		if g.r.IntN(20) == 0 {
			// No level token: level stays unknown (SD-09).
			e.Body = fmt.Sprintf("%s - [%d]: %s", stamp, 1000+g.r.IntN(9000), msg)
			raw = ""
		} else {
			e.Body = fmt.Sprintf("%s - %s [%d]: %s", stamp, raw, 1000+g.r.IntN(9000), msg)
		}
	}
	if raw == "" {
		e.Level, e.LevelRaw = "UNKNOWN", ""
	} else {
		e.Level, e.LevelRaw = strings.ToUpper(raw), raw
	}
	e.TimeFlags = FlagZoneGuessed
	e.ParseStatus = "none"
	e.Fields = map[string]any{}
}

var pinoLevels = map[string]int{"TRACE": 10, "DEBUG": 20, "INFO": 30, "WARN": 40, "ERROR": 50, "FATAL": 60}

// jsonEvent makes Pino lines: J1 with level labels, J2 with numbers.
func (g *Generator) jsonEvent(e *Event, needle string) {
	lvl := g.pickLevel()
	e.RefTime = e.RefTime.Truncate(time.Millisecond)
	fields := map[string]any{
		"time":     e.RefTime.UnixMilli(),
		"pid":      1000 + int(e.Src.ServerID),
		"hostname": e.Src.Host,
		"msg":      g.message(needle),
	}
	if e.Src.Format == J1 {
		fields["level"] = strings.ToLower(lvl)
		e.LevelRaw = strings.ToLower(lvl)
	} else {
		fields["level"] = pinoLevels[lvl]
		e.LevelRaw = strconv.Itoa(pinoLevels[lvl])
	}
	e.Level = lvl
	if g.r.IntN(10) < 6 {
		rt := routes[g.p.zRoute.Uint64()]
		code := g.status(rt)
		var status any = code
		if g.r.IntN(100) == 0 {
			status = strconv.Itoa(code) // type conflict on the same path (SD-20)
		}
		fields["reqId"] = fmt.Sprintf("req-%x", g.r.IntN(1<<28))
		fields["req"] = map[string]any{"method": rt.method, "url": g.routePath(rt)}
		fields["res"] = map[string]any{"statusCode": status}
		fields["responseTime"] = g.r.IntN(800)
	}
	if g.r.IntN(10) < 3 {
		if g.r.IntN(20) == 0 {
			fields["user_id"] = fmt.Sprintf("u%d", g.id()) // type conflict
		} else {
			fields["user_id"] = g.id()
		}
	}
	if g.r.IntN(100) == 0 {
		fields["payload"] = g.longText(4096 + g.r.IntN(12_288))
	}
	if lvl == "ERROR" || lvl == "FATAL" {
		if g.r.IntN(5) == 0 {
			fields["err"] = map[string]any{"type": "Error", "message": "upstream request failed", "stack": g.stack()}
		}
	}
	body, _ := json.Marshal(fields)
	e.Body = string(body)
	if g.r.IntN(20) == 0 && hasNonASCII(e.Body) {
		// Escaped non-ASCII as some loggers write it; search also sees the
		// decoded text (SD-16).
		e.BodyUnescaped = e.Body
		e.Body = escapeNonASCII(e.Body)
	}
	e.ParseStatus = "ok"
	e.Fields = fields
}

func (g *Generator) longText(n int) string {
	var b strings.Builder
	for b.Len() < n {
		b.WriteString(g.p.words[g.r.IntN(len(g.p.words))])
		b.WriteByte(' ')
		b.WriteString(strconv.Itoa(g.r.IntN(1_000_000)))
		b.WriteByte(' ')
	}
	return b.String()
}

func hasNonASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return true
		}
	}
	return false
}

func escapeNonASCII(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r < utf8.RuneSelf {
			b.WriteRune(r)
			continue
		}
		fmt.Fprintf(&b, `\u%04x`, r)
	}
	return b.String()
}
