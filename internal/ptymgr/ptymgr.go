// Package ptymgr owns the lifecycle of live PTYs in the c3-server.
//
// One PTY per "session key" (tmux-style identity). The key is normally a
// Claude session UUID, but for brand-new sessions that haven't been
// assigned a uuid yet, it's the c3-internal id instead. A discovery loop
// watches claudefs for new uuids in the session's cwd and fires the
// OnUUIDDiscovered hook so the server can PATCH the entry. Opening a
// session that already has a live PTY attaches to it rather than spawning
// a second `claude` on the same identity — which would conflict on the
// JSONL file for resumed sessions.
//
// Single-attach: at most one Client may be bound to a given PTY at once.
// A new attach kicks the prior one with a `{"type":"kicked"}` notice.
package ptymgr

import (
	"io"
	"sync"
	"sync/atomic"
	"time"

	"github.com/binhsonnguyen/ccc/adapters/claudefs"
	"github.com/binhsonnguyen/ccc/adapters/ptyrunner"
	"github.com/binhsonnguyen/ccc/core"
)

// scrollbackSize is the per-PTY ring buffer cap (~2 MB raw bytes). Replay
// is whole-buffer; known limitation is that the head of the buffer can
// fall mid-escape-sequence and render a stray glyph until the next full
// repaint by claude. Acceptable for v5 MVP.
const scrollbackSize = 2 * 1024 * 1024

// graceAfterExit is how long a Session lingers in the map after the child
// exits, so a still-attached client can receive the `exit` frame before
// the entry is GC'd.
const graceAfterExit = 5 * time.Second

// Discovery loop tunables for pending-uuid sessions (D-7). Poll claudefs
// every discoveryInterval up to discoveryTimeout total before giving up.
// The session keeps running; the user just won't see a uuid in the list
// until the next manual bind. Counts: 30s / 500ms = 60 polls.
//
// Stored via atomics so tests can override safely without racing
// against running discovery goroutines.
var (
	discoveryIntervalNs atomic.Int64
	discoveryTimeoutNs  atomic.Int64
)

func init() {
	discoveryIntervalNs.Store(int64(500 * time.Millisecond))
	discoveryTimeoutNs.Store(int64(30 * time.Second))
}

func discoveryInterval() time.Duration { return time.Duration(discoveryIntervalNs.Load()) }
func discoveryTimeout() time.Duration  { return time.Duration(discoveryTimeoutNs.Load()) }

// Client is what a transport (WebSocket) implements so the manager can
// push bytes + control frames at it. All methods must be safe to call
// concurrently with each other; the manager will not call them in
// parallel from multiple goroutines, but the transport may close
// underneath us at any time.
type Client interface {
	// WriteBytes pushes raw PTY stdout to the client (binary frame).
	WriteBytes(p []byte) error
	// WriteControl sends a JSON control message (text frame).
	WriteControl(v any) error
	// Close terminates the client connection.
	Close() error
}

// Session is one live PTY + its scrollback + currently-attached client.
//
// Key is the manager-map key (claude uuid OR c3 id while pending). UUID
// is the claude uuid (empty while pending). After discovery fires, UUID
// gets filled in but Key stays as-is — re-keying mid-flight is more
// trouble than it's worth and the server's lookup goes through c3 id
// anyway.
type Session struct {
	Key  string
	UUID string
	pty  *ptyrunner.Session

	mu       sync.Mutex
	ring     *ringBuffer
	activity activityRing // 60-bucket × 1s ring of bytes/sec (C-1)
	client   Client       // currently attached client, or nil
	exited   bool
	exitCode int

	// done closes when the reader goroutine has fully drained the PTY and
	// the child has been reaped. Used by Manager to schedule GC.
	done chan struct{}

	// stopDiscovery, if non-nil, signals the discovery goroutine to exit
	// early when the session is killed or the child exits. Set on Attach
	// for pending sessions, nil otherwise.
	stopDiscovery chan struct{}
}

// scanner abstracts the bits of claudefs.Repo the discovery loop needs.
// Tests inject a fake; production wires claudefs.New().
//
// ScanProject narrows to a single cwd's project dir — discovery polls
// this every interval, so per-tick cost stays O(JSONL count in ONE
// project) instead of O(all projects). Scan() is used only for the
// pre-spawn snapshot, which fires once per pending Attach.
type scanner interface {
	Scan() ([]core.Session, error)
	ScanProject(cwd string) ([]core.Session, error)
}

// Manager is the registry of live PTY sessions, keyed by session key
// (claude uuid OR c3 id). Safe for concurrent use.
type Manager struct {
	mu       sync.Mutex
	sessions map[string]*Session

	// claimedUUIDs tracks claude uuids that some pending discovery has
	// already claimed for binding. Two pending sessions in the same cwd
	// would otherwise both observe the same new JSONL and both fire the
	// hook — the second usecase.Bind returns ErrAlreadyBound and the
	// second entry stays pending forever. TryClaimUUID is an atomic
	// check-and-set under m.mu that resolves the race deterministically:
	// the loser keeps polling (or eventually times out).
	claimedUUIDs map[string]bool

	// onActivity, if set, is invoked whenever a PTY is spawned, attached
	// to, or detached from. The server uses it to reset its idle watchdog
	// timer so we don't shut down with a live PTY in the map.
	onActivity func()

	// onUUIDDiscovered, if set, fires when the discovery loop links a
	// pending session to a freshly-written Claude JSONL. Called with the
	// session key (= c3 id while pending) and the discovered uuid. The
	// server uses it to PATCH the entry via usecase.Bind.
	onUUIDDiscovered func(sessionKey, newUUID string)

	// startPTY is the function used to spawn a PTY. Production code uses
	// ptyrunner.Start; tests swap in a stub so they don't depend on the
	// real `claude` binary being installed.
	startPTY func(cwd, uuid string) (*ptyrunner.Session, error)

	// claudeScan is the claudefs scanner used by the discovery loop.
	// Tests swap in a fake that returns synthetic sessions.
	claudeScan scanner
}

func New() *Manager {
	return &Manager{
		sessions:     map[string]*Session{},
		claimedUUIDs: map[string]bool{},
		startPTY:     ptyrunner.Start,
		claudeScan:   claudefs.New(),
	}
}

// SetActivityHook installs a callback fired on every Attach/Detach. Used
// by the server's idle watchdog. Pass nil to clear.
func (m *Manager) SetActivityHook(f func()) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onActivity = f
}

// SetUUIDDiscoveredHook installs the callback fired when a pending
// session's uuid is discovered via claudefs. Pass nil to clear. The
// hook runs in the discovery goroutine; it should not block.
func (m *Manager) SetUUIDDiscoveredHook(f func(sessionKey, newUUID string)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onUUIDDiscovered = f
}

// Count returns the number of live PTY sessions (including those in the
// post-exit grace period).
func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sessions)
}

// AttachedCount returns the number of sessions that currently have a
// client attached. Multiple sessions may exist without any attached
// client (detached scrollback-only).
func (m *Manager) AttachedCount() int {
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	m.mu.Unlock()
	n := 0
	for _, s := range sessions {
		s.mu.Lock()
		if s.client != nil {
			n++
		}
		s.mu.Unlock()
	}
	return n
}

// HasUUID reports whether any live session is keyed by, or has had its
// UUID upgraded to, the given claude uuid. Used by usecase.Remove to
// refuse destructive ops on a live PTY without force.
func (m *Manager) HasUUID(uuid string) bool {
	if uuid == "" {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.sessions {
		// Match either current key (covers the resumed case where key =
		// uuid from the start) or upgraded UUID (covers pending sessions
		// after discovery filled in the uuid but kept the c3-id key).
		if s.Key == uuid || s.UUID == uuid {
			return true
		}
	}
	return false
}

// KillUUID SIGKILLs any session whose UUID or Key matches. Best-effort;
// no-op if absent. The reader goroutine reaps and GCs.
func (m *Manager) KillUUID(uuid string) {
	if uuid == "" {
		return
	}
	m.mu.Lock()
	var victims []*Session
	for _, s := range m.sessions {
		if s.Key == uuid || s.UUID == uuid {
			victims = append(victims, s)
		}
	}
	m.mu.Unlock()
	for _, s := range victims {
		_ = s.Kill()
	}
}

// HasKey reports whether a session is registered under the given manager
// key (c3 id for pending sessions, uuid otherwise). Use-cases gate
// pending-session removal on this — a pending PTY has no uuid yet so
// HasUUID can't see it.
func (m *Manager) HasKey(key string) bool {
	if key == "" {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.sessions[key]
	return ok
}

// GetSession returns the live Session keyed by `key` (claude uuid OR
// c3 id for pending sessions), or nil if absent. Read-only accessor —
// callers must not mutate the session, only call its public methods.
func (m *Manager) GetSession(key string) *Session {
	if key == "" {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[key]
}

// GetSessionByUUID returns the live Session whose UUID or Key matches
// the given claude uuid, or nil if absent. Mirrors HasUUID's matching
// rules so callers that only know the claude uuid (not the manager
// key) can still find the session.
func (m *Manager) GetSessionByUUID(uuid string) *Session {
	if uuid == "" {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.sessions {
		if s.Key == uuid || s.UUID == uuid {
			return s
		}
	}
	return nil
}

// TailBytes returns up to `n` of the most recent bytes from this
// session's scrollback ring buffer. `n` is clamped to [256, 32768];
// passing 0 or negative yields the default 8192. Returns nil if the
// ring is empty. Lock-safe: copies under s.mu so the reader goroutine
// can't mutate mid-read.
func (s *Session) TailBytes(n int) []byte {
	const (
		minN = 256
		maxN = 32 * 1024
		defN = 8 * 1024
	)
	if n <= 0 {
		n = defN
	}
	if n < minN {
		n = minN
	}
	if n > maxN {
		n = maxN
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	snap := s.ring.snapshot()
	if len(snap) <= n {
		return snap
	}
	return snap[len(snap)-n:]
}

// KillKey SIGKILLs the session at `key`. Best-effort; no-op if absent.
func (m *Manager) KillKey(key string) {
	if key == "" {
		return
	}
	m.mu.Lock()
	s, ok := m.sessions[key]
	m.mu.Unlock()
	if !ok {
		return
	}
	_ = s.Kill()
}

// TryClaimUUID atomically reserves `uuid` for the session at sessionKey.
// Returns true if this caller won the race (uuid not previously claimed
// AND not currently bound to a different live session). Used by the
// discovery loop so two pending sessions in the same cwd don't both fire
// the bind hook for the same Claude-written JSONL.
func (m *Manager) TryClaimUUID(sessionKey, uuid string) bool {
	if uuid == "" {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.claimedUUIDs[uuid] {
		return false
	}
	// Also reject if a DIFFERENT live session already has this uuid.
	for k, s := range m.sessions {
		if k == sessionKey {
			continue
		}
		if s.UUID == uuid || s.Key == uuid {
			return false
		}
	}
	m.claimedUUIDs[uuid] = true
	return true
}

// fireActivity calls the registered hook (if any). Caller must NOT hold
// m.mu — the hook is user code and may take arbitrary time.
func (m *Manager) fireActivity() {
	m.mu.Lock()
	f := m.onActivity
	m.mu.Unlock()
	if f != nil {
		f()
	}
}

// Attach binds c to the PTY for the given session key. If no PTY exists
// for that key, one is spawned via startPTY(cwd, claudeUUID). When
// claudeUUID is empty, the spawn runs `claude` (no resume) and a
// discovery goroutine watches claudefs in cwd for a new uuid; on first
// match it fires the OnUUIDDiscovered hook with (key, newUUID).
//
// If a prior client is attached, it's kicked (notified + closed). After
// binding, the scrollback is replayed to c synchronously so the caller
// can return knowing the client has state.
//
// Returns the bound Session. Caller MUST eventually call Detach when the
// client disconnects.
func (m *Manager) Attach(key, cwd, claudeUUID string, c Client) (*Session, error) {
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		p, err := m.startPTY(cwd, claudeUUID)
		if err != nil {
			m.mu.Unlock()
			return nil, err
		}
		s = &Session{
			Key:  key,
			UUID: claudeUUID,
			pty:  p,
			ring: newRing(scrollbackSize),
			done: make(chan struct{}),
		}
		// Pending session: spawn the discovery goroutine. Snapshot uuids
		// present in claudefs for THIS cwd BEFORE we go to sleep so we
		// only act on uuids that appeared after this spawn. We use
		// ScanProject here (single project dir) for the same reason as
		// the loop itself: full Scan() can be expensive.
		if claudeUUID == "" {
			s.stopDiscovery = make(chan struct{})
			snapshot := snapshotProjectUUIDs(m.claudeScan, cwd)
			go m.discoveryLoop(s, cwd, snapshot)
		}
		m.sessions[key] = s
		go m.readLoop(s)
	}
	m.mu.Unlock()

	s.mu.Lock()
	// Kick prior attached client, if any. Detach from s.client FIRST so the
	// reader goroutine won't try to write to it. Then close async — a sync
	// Close() here would block the critical section behind prev's writeMu
	// (which may be mid-WriteBytes with a slow client).
	if prev := s.client; prev != nil {
		_ = prev.WriteControl(map[string]any{"type": "kicked"})
		s.client = nil
		go prev.Close()
	}
	s.client = c
	snapshot := s.ring.snapshot()
	// If the PTY already exited (e.g. claude crashed before this client
	// attached), surface that immediately after the replay.
	exited, code := s.exited, s.exitCode

	// Replay scrollback INSIDE the critical section. Otherwise the reader
	// goroutine could race in between unlock and WriteBytes(snapshot) and
	// deliver a newer chunk to the client before the replay arrives,
	// scrambling the terminal state machine. Holding s.mu through the
	// write blocks the reader until replay has been queued in order.
	if len(snapshot) > 0 {
		_ = c.WriteBytes(snapshot)
	}
	if exited {
		_ = c.WriteControl(map[string]any{"type": "exit", "code": code})
	}
	// Pending control frame: tell the client that claude is still
	// initializing and no uuid has been linked yet. The client (PR 2)
	// uses this to disable stdin until the matching {"type":"ready"}
	// frame arrives at discovery time — avoids TTY line-discipline
	// reorder/duplicate while claude switches to raw mode.
	pending := s.UUID == ""
	s.mu.Unlock()
	if pending {
		_ = c.WriteControl(map[string]any{"type": "pending"})
	}
	m.fireActivity()
	return s, nil
}

// Detach unbinds c from s if c is still the attached client. Does NOT
// kill the PTY — that's the whole point of detach vs kill. Safe to call
// multiple times.
func (m *Manager) Detach(s *Session, c Client) {
	s.mu.Lock()
	if s.client == c {
		s.client = nil
	}
	s.mu.Unlock()
	m.fireActivity()
}

// WriteStdin forwards bytes from the client into the PTY master. Caller
// holds no lock. While a pending session is still waiting for its uuid,
// claude has already started inside the PTY — keystrokes go straight in,
// no buffering needed.
func (s *Session) WriteStdin(p []byte) error {
	_, err := s.pty.Master.Write(p)
	return err
}

// Resize forwards a window-size change to the PTY.
func (s *Session) Resize(cols, rows uint16) error {
	return s.pty.Resize(cols, rows)
}

// Kill SIGKILLs the child. The reader goroutine will then observe EOF,
// reap, and the manager will GC the entry after graceAfterExit.
func (s *Session) Kill() error {
	return s.pty.Kill()
}

// KillAll terminates every live PTY. Used at server shutdown.
func (m *Manager) KillAll() {
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	m.mu.Unlock()
	for _, s := range sessions {
		_ = s.Kill()
	}
	// Wait briefly for readers to drain; don't hang forever on a stuck child.
	deadline := time.After(2 * time.Second)
	for _, s := range sessions {
		select {
		case <-s.done:
		case <-deadline:
			return
		}
	}
}

// readLoop continuously drains the PTY master, pushes into the ring
// buffer, and (under lock) forwards to whichever client is attached.
// Exits on EOF / read error, reaps the child, emits an `exit` frame to
// any still-attached client, and schedules GC of the session entry.
func (m *Manager) readLoop(s *Session) {
	defer close(s.done)
	buf := make([]byte, 32*1024)
	for {
		n, err := s.pty.Master.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			s.mu.Lock()
			s.ring.write(chunk)
			s.activity.record(time.Now(), n)
			c := s.client
			s.mu.Unlock()
			if c != nil {
				if werr := c.WriteBytes(chunk); werr != nil {
					// Client write failed (likely write timeout). Detach
					// now and force-close async so the browser sees a
					// disconnect rather than an orphaned half-open WS.
					// Close runs in a goroutine because it must take the
					// client's writeMu, which the failing write may still
					// be holding.
					s.mu.Lock()
					if s.client == c {
						s.client = nil
					}
					s.mu.Unlock()
					go c.Close()
				}
			}
		}
		if err != nil {
			if err != io.EOF {
				// Non-EOF read error: most likely the master FD was
				// closed by Kill. Either way we exit the loop and reap.
			}
			break
		}
	}
	code, _ := s.pty.Wait()
	s.mu.Lock()
	s.exited = true
	s.exitCode = code
	c := s.client
	// Stop discovery if still running — child is gone, no uuid will appear.
	if s.stopDiscovery != nil {
		select {
		case <-s.stopDiscovery:
		default:
			close(s.stopDiscovery)
		}
	}
	s.mu.Unlock()
	if c != nil {
		_ = c.WriteControl(map[string]any{"type": "exit", "code": code})
		_ = c.Close()
	}

	// GC after grace so a late-attaching client can still observe exit.
	time.AfterFunc(graceAfterExit, func() {
		m.mu.Lock()
		if cur, ok := m.sessions[s.Key]; ok && cur == s {
			delete(m.sessions, s.Key)
		}
		m.mu.Unlock()
		m.fireActivity()
	})
}

// snapshotProjectUUIDs records the uuids currently present in claudefs
// for the given cwd's project dir. The discovery loop subtracts this
// from each subsequent ScanProject to identify uuids that appeared
// AFTER we spawned. Failures here return an empty set — worst case is
// one false positive on the very first poll, which TryClaimUUID and
// the cwd filter catch downstream.
func snapshotProjectUUIDs(s scanner, cwd string) map[string]bool {
	out := map[string]bool{}
	if s == nil {
		return out
	}
	ss, err := s.ScanProject(cwd)
	if err != nil {
		return out
	}
	for _, x := range ss {
		out[x.UUID] = true
	}
	return out
}

// discoveryLoop polls claudefs (scoped to cwd's project dir, not the
// whole tree) for new uuids. On first claimable match it fires the
// OnUUIDDiscovered hook and exits. Times out after discoveryTimeout —
// the session keeps running but stays pending.
func (m *Manager) discoveryLoop(s *Session, cwd string, before map[string]bool) {
	ticker := time.NewTicker(discoveryInterval())
	defer ticker.Stop()
	timeout := time.After(discoveryTimeout())
	for {
		select {
		case <-s.stopDiscovery:
			return
		case <-timeout:
			// Give up silently; entry stays pending. UX expectation: user
			// can either re-attempt or remove and recreate.
			return
		case <-ticker.C:
		}
		// Don't fire the hook if the session is already exiting — the
		// entry may have been removed or be about to be, and binding a
		// uuid onto a deleted entry just produces a stray Bind error.
		s.mu.Lock()
		exited := s.exited
		s.mu.Unlock()
		if exited {
			return
		}

		ss, err := m.claudeScan.ScanProject(cwd)
		if err != nil {
			continue
		}
		for _, x := range ss {
			if before[x.UUID] {
				continue
			}
			if x.Sidechain {
				continue
			}
			// ScanProject already restricts to cwd's project dir, but
			// Claude may have re-keyed the project (rare); double-check.
			if x.CWD != cwd {
				continue
			}
			// Race gate: only the first pending session to claim this
			// uuid fires the hook. Losers keep polling.
			if !m.TryClaimUUID(s.Key, x.UUID) {
				continue
			}
			// Won the claim. Upgrade in-memory state and fire the hook.
			s.mu.Lock()
			s.UUID = x.UUID
			c := s.client
			s.mu.Unlock()
			// Tell the currently-attached client (if any) that stdin is
			// now safe — claude has switched to raw mode by the time
			// JSONL appears. Best-effort; client may be mid-detach.
			if c != nil {
				_ = c.WriteControl(map[string]any{"type": "ready", "claudeUuid": x.UUID})
			}
			m.mu.Lock()
			hook := m.onUUIDDiscovered
			m.mu.Unlock()
			if hook != nil {
				hook(s.Key, x.UUID)
			}
			return
		}
	}
}

// ringBuffer is a fixed-capacity circular byte buffer. write() always
// succeeds, dropping the oldest bytes when full. snapshot() returns a
// linearized copy of the current contents.
//
// We do NOT attempt to cut on ESC-sequence boundaries. See package doc.
type ringBuffer struct {
	buf  []byte
	size int // capacity
	len  int // bytes currently in buffer
	head int // index of oldest byte
}

func newRing(cap int) *ringBuffer {
	return &ringBuffer{buf: make([]byte, cap), size: cap}
}

func (r *ringBuffer) write(p []byte) {
	for len(p) > 0 {
		// If incoming chunk is larger than capacity, only the tail fits.
		if len(p) >= r.size {
			copy(r.buf, p[len(p)-r.size:])
			r.head = 0
			r.len = r.size
			return
		}
		tail := (r.head + r.len) % r.size
		n := copy(r.buf[tail:], p)
		r.len += n
		if r.len > r.size {
			over := r.len - r.size
			r.head = (r.head + over) % r.size
			r.len = r.size
		}
		p = p[n:]
	}
}

// activityRing is a 60-bucket × 1-second rolling counter of PTY-stdout
// bytes used to draw the sidebar sparkline (PLAN.md C-1). All access is
// expected to happen under the owning Session's mu — the ring keeps no
// internal lock to avoid double-locking on the hot reader path.
//
// Buckets are indexed by absolute second (Unix time % 60). On every
// record() the ring zeros out any buckets whose owning second is older
// than the most-recent observed second — a cheap form of TTL that
// avoids a background ticker. snapshot() does the same alignment so
// stale data never appears in the output.
type activityRing struct {
	buckets [60]uint32
	head    int       // index of the most-recent bucket
	headT   time.Time // unix-second start of the most-recent bucket
}

// secFloor returns t truncated to the start of its second.
func secFloor(t time.Time) time.Time {
	return time.Unix(t.Unix(), 0)
}

// record accumulates n bytes into the bucket for `now`, rotating the
// ring forward if `now` falls into a later second than headT. Buckets
// for skipped seconds are zeroed (no activity).
func (a *activityRing) record(now time.Time, n int) {
	if n <= 0 {
		return
	}
	nowS := secFloor(now)
	if a.headT.IsZero() {
		a.headT = nowS
		a.head = 0
		a.buckets[0] = uint32(n)
		return
	}
	diff := int(nowS.Sub(a.headT) / time.Second)
	if diff < 0 {
		// Clock jumped backwards. Treat as same second — better than
		// rewriting history. Don't move head.
		a.buckets[a.head] += uint32(n)
		return
	}
	if diff == 0 {
		a.buckets[a.head] += uint32(n)
		return
	}
	if diff >= 60 {
		// Gap exceeded the window — wipe everything.
		for i := range a.buckets {
			a.buckets[i] = 0
		}
		a.head = 0
		a.headT = nowS
		a.buckets[0] = uint32(n)
		return
	}
	// Advance head `diff` times, zeroing intermediate buckets.
	for i := 0; i < diff; i++ {
		a.head = (a.head + 1) % 60
		a.buckets[a.head] = 0
	}
	a.headT = nowS
	a.buckets[a.head] = uint32(n)
}

// snapshot returns the 60 buckets aligned so index 59 == most-recent
// second (relative to `now`). Buckets older than 60s are returned as
// zero. Caller receives a value copy — safe to inspect outside the
// lock.
func (a *activityRing) snapshot(now time.Time) [60]uint32 {
	var out [60]uint32
	if a.headT.IsZero() {
		return out
	}
	nowS := secFloor(now)
	skew := int(nowS.Sub(a.headT) / time.Second)
	if skew < 0 {
		skew = 0
	}
	if skew >= 60 {
		return out
	}
	// Walk the ring from oldest → newest. The bucket at logical
	// position p (0..59) in the head-relative view corresponds to
	// physical index (a.head - (59 - p) + 60) % 60 and is `59 - p`
	// seconds older than headT. After we apply `skew` to account for
	// `now` being newer than `headT`, the same bucket is
	// (59 - p) + skew seconds older than `now`.
	for p := 0; p < 60; p++ {
		// ageFromNow: how many seconds older than `now` this slot is.
		ageFromNow := 59 - p
		// ageFromHead: same, but relative to headT (the most-recent
		// recorded second). Negative means "newer than head" → no data.
		ageFromHead := ageFromNow - skew
		if ageFromHead < 0 || ageFromHead >= 60 {
			out[p] = 0
			continue
		}
		idx := (a.head - ageFromHead + 60*2) % 60
		out[p] = a.buckets[idx]
	}
	return out
}

// Activity returns a lock-safe snapshot of the bytes/sec ring aligned
// so index 59 is the most-recent second. Lengths zero out beyond the
// 60-second window. Use for the sidebar sparkline.
func (s *Session) Activity() [60]uint32 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.activity.snapshot(time.Now())
}

func (r *ringBuffer) snapshot() []byte {
	if r.len == 0 {
		return nil
	}
	out := make([]byte, r.len)
	if r.head+r.len <= r.size {
		copy(out, r.buf[r.head:r.head+r.len])
	} else {
		first := r.size - r.head
		copy(out, r.buf[r.head:])
		copy(out[first:], r.buf[:r.len-first])
	}
	return out
}
