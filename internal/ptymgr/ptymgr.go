// Package ptymgr owns the lifecycle of live PTYs in the c2-server.
//
// One PTY per Claude session UUID (tmux-style identity). Opening a session
// that already has a live PTY attaches to it rather than spawning a second
// `claude --resume <uuid>` on the same uuid — which would conflict on the
// JSONL file. Detaching (browser tab close) leaves the PTY running; the
// next attach replays scrollback from the ring buffer.
//
// Single-attach: at most one Client may be bound to a given PTY at once.
// A new attach kicks the prior one with a `{"type":"kicked"}` notice.
package ptymgr

import (
	"io"
	"sync"
	"time"

	"c2/adapters/ptyrunner"
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
type Session struct {
	UUID string
	pty  *ptyrunner.Session

	mu       sync.Mutex
	ring     *ringBuffer
	client   Client // currently attached client, or nil
	exited   bool
	exitCode int

	// done closes when the reader goroutine has fully drained the PTY and
	// the child has been reaped. Used by Manager to schedule GC.
	done chan struct{}
}

// Manager is the registry of live PTY sessions, keyed by UUID. Safe for
// concurrent use.
type Manager struct {
	mu       sync.Mutex
	sessions map[string]*Session

	// onActivity, if set, is invoked whenever a PTY is spawned, attached
	// to, or detached from. The server uses it to reset its idle watchdog
	// timer so we don't shut down with a live PTY in the map.
	onActivity func()

	// startPTY is the function used to spawn a PTY. Production code uses
	// ptyrunner.Start; tests swap in a stub so they don't depend on the
	// real `claude` binary being installed.
	startPTY func(cwd, uuid string) (*ptyrunner.Session, error)
}

func New() *Manager {
	return &Manager{
		sessions: map[string]*Session{},
		startPTY: ptyrunner.Start,
	}
}

// SetActivityHook installs a callback fired on every Attach/Detach. Used
// by the server's idle watchdog. Pass nil to clear.
func (m *Manager) SetActivityHook(f func()) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onActivity = f
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

// Attach binds c to the PTY for uuid. If no PTY exists, one is spawned
// via ptyrunner.Start(cwd, uuid). If a prior client is attached, it's
// kicked (notified + closed). After binding, the scrollback is replayed
// to c synchronously so the caller can return knowing the client has
// state.
//
// Returns the bound Session. Caller MUST eventually call Detach when the
// client disconnects.
func (m *Manager) Attach(uuid, cwd string, c Client) (*Session, error) {
	m.mu.Lock()
	s, ok := m.sessions[uuid]
	if !ok {
		p, err := m.startPTY(cwd, uuid)
		if err != nil {
			m.mu.Unlock()
			return nil, err
		}
		s = &Session{
			UUID: uuid,
			pty:  p,
			ring: newRing(scrollbackSize),
			done: make(chan struct{}),
		}
		m.sessions[uuid] = s
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
	s.mu.Unlock()
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
// holds no lock.
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
	s.mu.Unlock()
	if c != nil {
		_ = c.WriteControl(map[string]any{"type": "exit", "code": code})
		_ = c.Close()
	}

	// GC after grace so a late-attaching client can still observe exit.
	time.AfterFunc(graceAfterExit, func() {
		m.mu.Lock()
		if cur, ok := m.sessions[s.UUID]; ok && cur == s {
			delete(m.sessions, s.UUID)
		}
		m.mu.Unlock()
		m.fireActivity()
	})
}

// ringBuffer is a fixed-capacity circular byte buffer. write() always
// succeeds, dropping the oldest bytes when full. snapshot() returns a
// linearized copy of the current contents.
//
// We do NOT attempt to cut on ESC-sequence boundaries. See package doc.
type ringBuffer struct {
	buf  []byte
	size int  // capacity
	len  int  // bytes currently in buffer
	head int  // index of oldest byte
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
