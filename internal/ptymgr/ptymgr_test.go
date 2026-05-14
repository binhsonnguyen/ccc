package ptymgr

import (
	"bytes"
	"errors"
	"os/exec"
	"sync"
	"syscall"
	"testing"
	"time"

	"c2/adapters/ptyrunner"

	"github.com/creack/pty"
)

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

// Writing more than capacity must leave only the last `size` bytes in the
// snapshot. This is the core property the scrollback replay depends on.
func TestRingBuffer_OverflowKeepsTail(t *testing.T) {
	r := newRing(8)
	r.write([]byte("ABCDEFGHIJKLMN")) // 14 bytes into cap 8
	got := r.snapshot()
	want := []byte("GHIJKLMN")
	if !bytes.Equal(got, want) {
		t.Fatalf("snapshot = %q, want %q", got, want)
	}
}

// Many small writes that together exceed capacity should also wrap
// correctly — the head pointer advances across the boundary.
func TestRingBuffer_WrapAroundManyWrites(t *testing.T) {
	r := newRing(4)
	for _, b := range []byte("12345678") {
		r.write([]byte{b})
	}
	got := r.snapshot()
	if !bytes.Equal(got, []byte("5678")) {
		t.Fatalf("snapshot = %q, want %q", got, "5678")
	}
}

// ---------------------------------------------------------------------------
// Fake PTY plumbing
//
// We swap m.startPTY for one that runs `cat` (or any caller-provided
// command) inside a real pty, so the read loop / exit semantics behave
// exactly as in production but we don't need `claude` installed.
// ---------------------------------------------------------------------------

func skipIfNoPTY(t *testing.T) {
	t.Helper()
	// On macOS dev boxes pty allocation always works. Headless CI
	// without /dev/ptmx would fail; we treat that as a skip rather
	// than a failure since the test is checking *our* logic, not
	// the kernel's pty subsystem.
	m, s, err := pty.Open()
	if err != nil {
		t.Skipf("pty.Open failed: %v", err)
		return
	}
	_ = m.Close()
	_ = s.Close()
}

// newFakePTYStarter returns a ptymgr startPTY-compatible func that
// launches the given command name + args inside a pty. Used by tests
// to inject `cat`, `sleep`, `echo` etc. in place of the real `claude`.
func newFakePTYStarter(name string, args ...string) func(cwd, uuid string) (*ptyrunner.Session, error) {
	return func(cwd, uuid string) (*ptyrunner.Session, error) {
		cmd := exec.Command(name, args...)
		if cwd != "" {
			cmd.Dir = cwd
		}
		master, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 24, Cols: 80})
		if err != nil {
			return nil, err
		}
		return &ptyrunner.Session{Master: master, Cmd: cmd}, nil
	}
}

// ---------------------------------------------------------------------------
// fakeClient — collects WriteBytes / WriteControl / Close for assertions.
// ---------------------------------------------------------------------------

type fakeClient struct {
	mu       sync.Mutex
	bytes    []byte
	controls []map[string]any
	closed   bool
	// closeErr returned from Close(); allows simulating a flaky transport.
	closeErr error
}

func (c *fakeClient) WriteBytes(p []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return errors.New("closed")
	}
	c.bytes = append(c.bytes, p...)
	return nil
}

func (c *fakeClient) WriteControl(v any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return errors.New("closed")
	}
	m, _ := v.(map[string]any)
	c.controls = append(c.controls, m)
	return nil
}

func (c *fakeClient) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	return c.closeErr
}

func (c *fakeClient) hasControl(typ string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, m := range c.controls {
		if t, _ := m["type"].(string); t == typ {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Single-attach kick
// ---------------------------------------------------------------------------

// When a second client attaches to the same uuid, the manager must:
//   - send {"type":"kicked"} to client A,
//   - close client A,
//   - keep client B as the current attach.
func TestAttach_KicksPriorClient(t *testing.T) {
	skipIfNoPTY(t)
	m := New()
	m.startPTY = newFakePTYStarter("cat") // cat blocks on stdin → stays alive

	a := &fakeClient{}
	sess, err := m.Attach("uuid-1", "", a)
	if err != nil {
		t.Fatalf("attach A: %v", err)
	}
	t.Cleanup(func() { _ = sess.Kill() })

	b := &fakeClient{}
	if _, err := m.Attach("uuid-1", "", b); err != nil {
		t.Fatalf("attach B: %v", err)
	}

	// Give the async close goroutine a moment.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		a.mu.Lock()
		ok := a.closed && len(a.controls) > 0
		a.mu.Unlock()
		if ok {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	if !a.hasControl("kicked") {
		t.Errorf("client A did not receive kicked control frame; controls=%v", a.controls)
	}
	a.mu.Lock()
	if !a.closed {
		t.Error("client A was not closed after being kicked")
	}
	a.mu.Unlock()

	b.mu.Lock()
	if b.closed {
		t.Error("client B was closed but should be the current attach")
	}
	b.mu.Unlock()
}

// ---------------------------------------------------------------------------
// Detach is NOT kill
// ---------------------------------------------------------------------------

// Detaching a client must leave the underlying child process alive. We
// verify by sending SIGNAL 0 (kill -0) to the child PID after Detach.
func TestDetach_KeepsPTYAlive(t *testing.T) {
	skipIfNoPTY(t)
	m := New()
	m.startPTY = newFakePTYStarter("cat")

	c := &fakeClient{}
	sess, err := m.Attach("uuid-detach", "", c)
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	t.Cleanup(func() { _ = sess.Kill() })

	pid := sess.pty.Cmd.Process.Pid
	m.Detach(sess, c)

	// Give the goroutine a beat in case anything tries to die.
	time.Sleep(50 * time.Millisecond)

	if sess.pty.Cmd.Process == nil {
		t.Fatalf("no process after detach")
	}
	if err := syscall.Kill(pid, 0); err != nil {
		t.Errorf("PTY process %d not alive after detach: %v", pid, err)
	}
	if m.Count() != 1 {
		t.Errorf("Count() = %d, want 1 after detach (PTY still tracked)", m.Count())
	}
}

// ---------------------------------------------------------------------------
// GC after exit
// ---------------------------------------------------------------------------

// When the child process exits, the manager must eventually remove the
// entry from its map (after graceAfterExit). We don't want to wait the
// full 5 seconds in CI, so this test patches the constant indirectly by
// running `echo` (immediate exit) and polling with a generous deadline.
func TestSession_GCAfterExit(t *testing.T) {
	skipIfNoPTY(t)
	m := New()
	// `true` exits 0 immediately — fastest available "PTY that dies".
	m.startPTY = newFakePTYStarter("true")

	c := &fakeClient{}
	_, err := m.Attach("uuid-gc", "", c)
	if err != nil {
		t.Fatalf("attach: %v", err)
	}

	// Wait for graceAfterExit + buffer. The grace is 5s in production;
	// we accept that as the cost of the test rather than wiring a knob.
	deadline := time.Now().Add(graceAfterExit + 2*time.Second)
	for time.Now().Before(deadline) {
		if m.Count() == 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if m.Count() != 0 {
		t.Fatalf("session not GC'd after exit; Count() = %d", m.Count())
	}
}

// ---------------------------------------------------------------------------
// Count / AttachedCount sanity
// ---------------------------------------------------------------------------

func TestCounts_AttachAndDetach(t *testing.T) {
	skipIfNoPTY(t)
	m := New()
	m.startPTY = newFakePTYStarter("cat")

	if m.Count() != 0 || m.AttachedCount() != 0 {
		t.Fatalf("fresh manager not zero: count=%d attached=%d", m.Count(), m.AttachedCount())
	}
	c := &fakeClient{}
	sess, err := m.Attach("u1", "", c)
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	t.Cleanup(func() { _ = sess.Kill() })

	if m.Count() != 1 {
		t.Errorf("Count = %d, want 1", m.Count())
	}
	if m.AttachedCount() != 1 {
		t.Errorf("AttachedCount = %d, want 1", m.AttachedCount())
	}
	m.Detach(sess, c)
	if m.AttachedCount() != 0 {
		t.Errorf("AttachedCount after detach = %d, want 0", m.AttachedCount())
	}
	if m.Count() != 1 {
		t.Errorf("Count after detach = %d, want 1 (PTY still alive)", m.Count())
	}
}
