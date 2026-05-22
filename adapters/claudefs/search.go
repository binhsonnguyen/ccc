package claudefs

import (
	"bufio"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// SearchMatch is one session-level hit returned by Search().
//
// Only one snippet is returned per session (the first matching line) to
// keep responses small — the sidebar shows this inline next to the row.
// MatchedAt is the file's mtime, used to order results by recency.
type SearchMatch struct {
	ClaudeUUID string    `json:"claudeUuid"`
	CWD        string    `json:"cwd"`
	Summary    string    `json:"summary,omitempty"`
	Snippet    string    `json:"snippet"`
	MatchedAt  time.Time `json:"matchedAt"`
}

// Hard caps on Search() inputs. The handler trims `limit` before calling
// us, but we double-check here so a direct caller can't smuggle a giant
// limit past the server.
const (
	searchLimitMax     = 50
	searchLimitDefault = 20
	searchQueryMin     = 3
	snippetRadius      = 30 // chars on each side of the match
	scannerInitial     = 1 << 16
	scannerMax         = 1 << 20
)

// ErrQueryTooShort is returned when q has fewer than searchQueryMin chars
// after trimming. The HTTP handler maps this to 400.
type ErrQueryTooShort struct{ Min int }

func (e ErrQueryTooShort) Error() string {
	return fmt.Sprintf("query must be at least %d characters", e.Min)
}

// Search greps every Claude JSONL file for a case-insensitive substring
// match of `query`. At most ONE hit per session is returned. Sidechain
// sessions are excluded. Results are sorted by file mtime descending.
//
// Returns (matches, truncated, err). `truncated` is true when at least
// one more session matched but was dropped by the limit.
//
// We don't JSON-parse the lines: substring match across the raw line is
// far cheaper, and the snippet is built on the raw bytes too (with ANSI
// stripped and line breaks collapsed). Lines longer than scannerMax are
// silently skipped — pathological for a JSONL message body and not worth
// crashing over.
func (r *Repo) Search(query string, limit int) ([]SearchMatch, bool, error) {
	q := strings.TrimSpace(query)
	if len(q) < searchQueryMin {
		return nil, false, ErrQueryTooShort{Min: searchQueryMin}
	}
	if limit <= 0 {
		limit = searchLimitDefault
	}
	if limit > searchLimitMax {
		limit = searchLimitMax
	}

	sessions, err := r.Scan()
	if err != nil {
		return nil, false, err
	}

	needle := strings.ToLower(q)

	// Sessions arrive sorted by Modified desc from Scan(); keep that
	// ordering so the most-recently-active sessions get scanned first.
	// Truncation drops oldest matches. We stop AT THE FIRST OVERFLOW HIT:
	// one extra `searchFile` call confirms there's at least one match
	// beyond `limit`, then we set truncated=true and break. Prior version
	// kept scanning every remaining JSONL just to count — wasted I/O and
	// alloc per session with no observable difference (wire format only
	// exposes the boolean).
	out := make([]SearchMatch, 0, limit)
	truncated := false

	for _, s := range sessions {
		if s.Sidechain {
			continue
		}
		if s.JSONLPath == "" {
			continue
		}
		snippet, ok := searchFile(s.JSONLPath, needle)
		if !ok {
			continue
		}
		if len(out) >= limit {
			truncated = true
			break
		}
		out = append(out, SearchMatch{
			ClaudeUUID: s.UUID,
			CWD:        s.CWD,
			Summary:    s.Summary,
			Snippet:    snippet,
			MatchedAt:  s.Modified,
		})
	}

	// Defensive resort by MatchedAt desc — Scan order should already be
	// this way but if a session lacks a Modified time it'd otherwise
	// drift to wherever Scan put it.
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].MatchedAt.After(out[j].MatchedAt)
	})
	return out, truncated, nil
}

// searchFile streams a JSONL file line by line and returns the snippet
// for the first matching line, or ("", false) on no match / open error.
// `needle` MUST already be lowercased by the caller.
func searchFile(path, needle string) (string, bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, scannerInitial), scannerMax)
	for scanner.Scan() {
		raw := scanner.Bytes()
		// strings.Contains on a lowercased copy is the simplest correct
		// case-insensitive substring match. Allocates per line but the
		// match-or-skip cost dominates I/O anyway for typical JSONL.
		lower := strings.ToLower(string(raw))
		idx := strings.Index(lower, needle)
		if idx < 0 {
			continue
		}
		return buildSnippet(string(raw), idx, len(needle)), true
	}
	// scanner.Err() ignored: a truncated/garbled file shouldn't kill the
	// whole search, just this file.
	return "", false
}

// ansiRe matches CSI / OSC / other ANSI escape sequences that may leak
// into Claude JSONL via assistant tool output. Kept narrow; the goal is
// readable snippets, not a perfect terminal emulator.
var ansiRe = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`)

// buildSnippet returns a ~60-char window around the match. ANSI escapes
// are stripped from the entire window; newlines/tabs become spaces; the
// original case is preserved.
func buildSnippet(line string, matchIdx, matchLen int) string {
	start := matchIdx - snippetRadius
	if start < 0 {
		start = 0
	}
	end := matchIdx + matchLen + snippetRadius
	if end > len(line) {
		end = len(line)
	}
	// Snap bounds outward to the nearest UTF-8 rune boundary. Without
	// this, a window cut mid-rune (Vietnamese/CJK/emoji ≥ 2 bytes per
	// codepoint) produces U+FFFD glyphs when the snippet is later ranged
	// for ANSI strip + whitespace collapse. Snapping outward never
	// truncates the match itself; at most 3 byte tests per edge.
	for start > 0 && !utf8.RuneStart(line[start]) {
		start--
	}
	for end < len(line) && !utf8.RuneStart(line[end]) {
		end++
	}
	window := line[start:end]
	window = ansiRe.ReplaceAllString(window, "")
	// Collapse any whitespace run (incl. literal "\n" pairs that survive
	// JSON encoding) into a single space — JSONL bodies often contain
	// embedded "\n" because the assistant's message text is one string.
	window = collapseWS(window)
	window = strings.TrimSpace(window)

	var b strings.Builder
	if start > 0 {
		b.WriteString("…")
	}
	b.WriteString(window)
	if end < len(line) {
		b.WriteString("…")
	}
	return b.String()
}

// collapseWS replaces runs of any whitespace (space, tab, CR, LF) with a
// single space. Faster than a regex for short windows.
func collapseWS(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	prevSpace := false
	for _, r := range s {
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' {
			if !prevSpace {
				b.WriteByte(' ')
				prevSpace = true
			}
			continue
		}
		b.WriteRune(r)
		prevSpace = false
	}
	return b.String()
}
