package gen

import (
	"compress/gzip"
	"io"
)

type countWriter struct{ n int64 }

func (c *countWriter) Write(p []byte) (int, error) { c.n += int64(len(p)); return len(p), nil }

// GzipRatio writes about rawBytes of one format as newline separated lines,
// gzips them at the default level (same as gzip -6 and logrotate) and returns
// the raw size, compressed size and compressed/raw ratio.
func GzipRatio(cfg Config, f Format, rawBytes int64) (raw, compressed int64, ratio float64) {
	g := New(cfg)
	cw := &countWriter{}
	zw, _ := gzip.NewWriterLevel(cw, gzip.DefaultCompression)
	for raw < rawBytes {
		e := g.Next()
		if e.Src.Format != f || e.Kind != "event" {
			continue
		}
		line := e.Body + "\n"
		raw += int64(len(line))
		io.WriteString(zw, line)
	}
	zw.Close()
	return raw, cw.n, float64(cw.n) / float64(raw)
}
