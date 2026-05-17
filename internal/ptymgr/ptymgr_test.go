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
	"c2/core"

	"github.com/creack/pty"
)

// fakeScanner is the test seam for the discovery loop. It returns the
// `current` slice each Scan() call; tests mutate `current` between
// attaching and asserting to simulate Claude writing a new JSONL.
type fakeScanner struct {
	mu      sync.Mutex
	current []core.Session
}

func (f *fakeScanner) set(ss []core.Session) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.current = append([]core.Session(nil), ss...)
}

func (f *fakeScanner) Scan() ([]core.Session, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]core.Session(nil), f.current...), nil
}

// ScanProject ignores the cwd argument in tests and returns the full
// fake set; individual tests can pre-filter `current` to the cwd in
// play if they care.
func (f *fakeScanner) ScanProject(cwd string) ([]core.Session, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]core.Session, 0, len(f.current))
	for _, s := range f.current {
		if cwd == "" || s.CWD == cwd {
			out = append(out, s)
		}
	}
	return out, nil
}

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

// TailBytes clamps n into [256, 32768] (with 0 → default 8192) and
// returns a copy of the last n bytes of the ring. Empty ring → nil.
func TestSession_TailBytes_ClampAndTail(t *testing.T) {
	s := &Session{ring: newRing(2048)}

	// Empty buffer.
	if got := s.TailBytes(1024); got != nil {
		t.Fatalf("empty TailBytes = %q, want nil", got)
	}

	// Fill with a known pattern. Last byte should always be the most
	// recent one written.
	payload := bytes.Repeat([]byte("abcdefghij"), 200) // 2000 bytes
	s.ring.write(payload)

	// Default (n=0) clamps to 8192 but ring only holds 2000 bytes.
	if got := s.TailBytes(0); !bytes.Equal(got, payload) {
		t.Fatalf("default TailBytes len = %d, want %d", len(got), len(payload))
	}

	// Below floor: 100 clamps up to 256.
	got := s.TailBytes(100)
	if len(got) != 256 {
		t.Fatalf("n=100 → len=%d, want 256", len(got))
	}
	if !bytes.Equal(got, payload[len(payload)-256:]) {
		t.Fatalf("n=100 tail mismatch")
	}

	// Above ceiling: 99999 clamps down to 32768 but ring smaller.
	got = s.TailBytes(99999)
	if !bytes.Equal(got, payload) {
		t.Fatalf("n=99999 should return whole ring")
	}

	// Exact in-range request.
	got = s.TailBytes(500)
	if len(got) != 500 {
		t.Fatalf("n=500 → len=%d", len(got))
	}
	if !bytes.Equal(got, payload[len(payload)-500:]) {
		t.Fatalf("n=500 tail mismatch")
	}
}

// TailBytes must coordinate with the reader goroutine via s.mu: a
// concurrent ring.write() during a TailBytes call must not race the
// snapshot. We hammer both sides with -race to surface any missing
// lock acquisition.
func TestSession_TailBytes_RaceWithWriter(t *testing.T) {
	s := &Session{ring: newRing(4096)}
	chunk := bytes.Repeat([]byte("x"), 128)
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				s.mu.Lock()
				s.ring.write(chunk)
				s.mu.Unlock()
			}
		}
	}()
	deadline := time.Now().Add(50 * time.Millisecond)
	for time.Now().Before(deadline) {
		_ = s.TailBytes(512)
	}
	close(stop)
	wg.Wait()
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
	sess, err := m.Attach("uuid-1", "", "uuid-1", a)
	if err != nil {
		t.Fatalf("attach A: %v", err)
	}
	t.Cleanup(func() { _ = sess.Kill() })

	b := &fakeClient{}
	if _, err := m.Attach("uuid-1", "", "uuid-1", b); err != nil {
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
	sess, err := m.Attach("uuid-detach", "", "uuid-detach", c)
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
	_, err := m.Attach("uuid-gc", "", "uuid-gc", c)
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
	sess, err := m.Attach("u1", "", "u1", c)
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

// ---------------------------------------------------------------------------
// D-7: pending-uuid sessions keyed by c2 id + discovery callback
// ---------------------------------------------------------------------------

// A pending Attach (claudeUUID == "") must:
//   - spawn the PTY with empty uuid (no --resume),
//   - register the session under the c2-id key,
//   - report HasUUID(uuid)==false until the discovery loop links one.
func TestAttach_PendingKeysByC2Id(t *testing.T) {
	skipIfNoPTY(t)
	m := New()
	// `cat` keeps the PTY alive without claude.
	m.startPTY = newFakePTYStarter("cat")
	// Empty scanner so the discovery loop never matches.
	m.claudeScan = &fakeScanner{}

	c := &fakeClient{}
	sess, err := m.Attach("c2id-001", "/tmp", "", c)
	if err != nil {
		t.Fatalf("attach pending: %v", err)
	}
	t.Cleanup(func() { _ = sess.Kill() })

	if sess.Key != "c2id-001" {
		t.Errorf("Key = %q, want %q", sess.Key, "c2id-001")
	}
	if sess.UUID != "" {
		t.Errorf("UUID = %q, want empty for pending session", sess.UUID)
	}
	// HasUUID for the eventual uuid is false right now (nothing bound).
	if m.HasUUID("some-future-uuid") {
		t.Error("HasUUID returned true for unrelated uuid")
	}
	if m.Count() != 1 {
		t.Errorf("Count = %d, want 1", m.Count())
	}
}

// When claudefs surfaces a new uuid in the session's cwd after attach,
// the discovery loop must fire OnUUIDDiscovered with (sessionKey, uuid),
// and HasUUID(uuid) must then return true.
func TestDiscovery_FiresHookOnNewUUID(t *testing.T) {
	skipIfNoPTY(t)
	m := New()
	m.startPTY = newFakePTYStarter("cat")
	scanner := &fakeScanner{}
	// Pre-existing uuid in the same cwd — we should NOT discover it
	// because it was present BEFORE attach (snapshot captures it).
	scanner.set([]core.Session{
		{UUID: "pre-existing", CWD: "/tmp"},
	})
	m.claudeScan = scanner

	got := make(chan [2]string, 1)
	m.SetUUIDDiscoveredHook(func(key, uuid string) {
		select {
		case got <- [2]string{key, uuid}:
		default:
		}
	})

	c := &fakeClient{}
	sess, err := m.Attach("c2id-002", "/tmp", "", c)
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	t.Cleanup(func() { _ = sess.Kill() })

	// Simulate claude having just written its first JSONL.
	scanner.set([]core.Session{
		{UUID: "pre-existing", CWD: "/tmp"},
		{UUID: "newly-created", CWD: "/tmp"},
		// Different cwd — must be ignored.
		{UUID: "wrong-cwd", CWD: "/var"},
	})

	select {
	case ev := <-got:
		if ev[0] != "c2id-002" || ev[1] != "newly-created" {
			t.Errorf("hook fired with (%q, %q); want (c2id-002, newly-created)", ev[0], ev[1])
		}
	case <-time.After(3 * time.Second):
		t.Fatal("discovery hook did not fire within 3s")
	}

	// After discovery, HasUUID should report true for the discovered uuid
	// even though the manager-map key is still the c2 id.
	if !m.HasUUID("newly-created") {
		t.Error("HasUUID('newly-created') = false after discovery")
	}
}

// B2: two pending sessions in the same cwd both observe the same new
// JSONL appear. Only one should win the claim and fire the bind hook;
// the loser keeps polling silently (and eventually times out). Without
// TryClaimUUID, both would fire, and usecase.Bind would reject the
// second with ErrAlreadyBound — leaving entry B permanently pending.
func TestDiscovery_TwoPendingSameCWD_OnlyOneClaims(t *testing.T) {
	skipIfNoPTY(t)
	// Speed up the test: tight interval, short timeout. Restored via
	// t.Cleanup. atomics keep the override race-free.
	origInterval := discoveryIntervalNs.Load()
	origTimeout := discoveryTimeoutNs.Load()
	discoveryIntervalNs.Store(int64(20 * time.Millisecond))
	discoveryTimeoutNs.Store(int64(500 * time.Millisecond))
	t.Cleanup(func() {
		discoveryIntervalNs.Store(origInterval)
		discoveryTimeoutNs.Store(origTimeout)
	})

	m := New()
	m.startPTY = newFakePTYStarter("cat")
	scanner := &fakeScanner{}
	m.claudeScan = scanner

	var hookMu sync.Mutex
	var hookCalls [][2]string
	m.SetUUIDDiscoveredHook(func(key, uuid string) {
		hookMu.Lock()
		defer hookMu.Unlock()
		hookCalls = append(hookCalls, [2]string{key, uuid})
	})

	ca := &fakeClient{}
	sa, err := m.Attach("c2id-A", "/tmp", "", ca)
	if err != nil {
		t.Fatalf("attach A: %v", err)
	}
	t.Cleanup(func() { _ = sa.Kill() })
	cb := &fakeClient{}
	sb, err := m.Attach("c2id-B", "/tmp", "", cb)
	if err != nil {
		t.Fatalf("attach B: %v", err)
	}
	t.Cleanup(func() { _ = sb.Kill() })

	// Same new uuid appears in /tmp — both discovery loops will see it.
	scanner.set([]core.Session{
		{UUID: "shared-new-uuid", CWD: "/tmp"},
	})

	// Wait long enough for both loops to either claim or skip.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		hookMu.Lock()
		n := len(hookCalls)
		hookMu.Unlock()
		if n >= 1 {
			// Give the loser a moment to also potentially fire (it must NOT).
			time.Sleep(200 * time.Millisecond)
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	hookMu.Lock()
	defer hookMu.Unlock()
	if len(hookCalls) != 1 {
		t.Fatalf("hook fired %d times, want exactly 1; calls=%v", len(hookCalls), hookCalls)
	}
	got := hookCalls[0]
	if got[1] != "shared-new-uuid" {
		t.Errorf("hook uuid = %q, want shared-new-uuid", got[1])
	}
	if got[0] != "c2id-A" && got[0] != "c2id-B" {
		t.Errorf("hook key = %q, want c2id-A or c2id-B", got[0])
	}
}

// C1: pending Attach must send {"type":"pending"} to the client so it
// knows to gate stdin.
func TestAttach_PendingSendsPendingFrame(t *testing.T) {
	skipIfNoPTY(t)
	m := New()
	m.startPTY = newFakePTYStarter("cat")
	m.claudeScan = &fakeScanner{}

	c := &fakeClient{}
	sess, err := m.Attach("c2id-pending-frame", "/tmp", "", c)
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	t.Cleanup(func() { _ = sess.Kill() })

	// WriteControl is sync inside Attach for the pending frame.
	if !c.hasControl("pending") {
		t.Errorf("client did not receive pending frame; controls=%v", c.controls)
	}
}

// Resumed (uuid known) Attach must NOT send the pending frame.
func TestAttach_ResumedNoPendingFrame(t *testing.T) {
	skipIfNoPTY(t)
	m := New()
	m.startPTY = newFakePTYStarter("cat")
	m.claudeScan = &fakeScanner{}

	c := &fakeClient{}
	sess, err := m.Attach("uuid-resumed", "/tmp", "uuid-resumed", c)
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	t.Cleanup(func() { _ = sess.Kill() })

	if c.hasControl("pending") {
		t.Errorf("resumed session sent stray pending frame; controls=%v", c.controls)
	}
}

// ---------------------------------------------------------------------------
// Activity ring (C-1)
// ---------------------------------------------------------------------------

// Recording bytes into the same second accumulates into the head bucket;
// the snapshot must surface that count at index 59 (most-recent).
func TestActivityRing_RecordSameSecond(t *testing.T) {
	var a activityRing
	now := time.Unix(1_000_000, 0)
	a.record(now, 100)
	a.record(now.Add(200*time.Millisecond), 50)
	snap := a.snapshot(now)
	if snap[59] != 150 {
		t.Fatalf("head bucket = %d, want 150", snap[59])
	}
	for i := 0; i < 59; i++ {
		if snap[i] != 0 {
			t.Fatalf("bucket[%d] = %d, want 0", i, snap[i])
		}
	}
}

// Rotating across seconds must place each second's bytes in a distinct
// bucket — and the most-recent must end up at index 59 regardless of
// how many seconds passed.
func TestActivityRing_RotateAcrossSeconds(t *testing.T) {
	var a activityRing
	start := time.Unix(2_000_000, 0)
	a.record(start, 10)
	a.record(start.Add(1*time.Second), 20)
	a.record(start.Add(2*time.Second), 30)
	now := start.Add(2 * time.Second)
	snap := a.snapshot(now)
	if snap[59] != 30 {
		t.Fatalf("snap[59]=%d want 30", snap[59])
	}
	if snap[58] != 20 {
		t.Fatalf("snap[58]=%d want 20", snap[58])
	}
	if snap[57] != 10 {
		t.Fatalf("snap[57]=%d want 10", snap[57])
	}
}

// Snapshotting `skew` seconds after the last record() should shift the
// most-recent data back by `skew` and zero-fill the newer slots.
func TestActivityRing_SnapshotSkewZeroFills(t *testing.T) {
	var a activityRing
	t0 := time.Unix(3_000_000, 0)
	a.record(t0, 42)
	snap := a.snapshot(t0.Add(5 * time.Second))
	// 5 seconds passed → bucket 42 should sit at index 54 (59-5).
	if snap[54] != 42 {
		t.Fatalf("snap[54]=%d want 42", snap[54])
	}
	for i := 55; i < 60; i++ {
		if snap[i] != 0 {
			t.Fatalf("snap[%d]=%d want 0 (after skew)", i, snap[i])
		}
	}
}

// Data older than the 60-second window must drop off entirely.
func TestActivityRing_AgesOut(t *testing.T) {
	var a activityRing
	t0 := time.Unix(4_000_000, 0)
	a.record(t0, 99)
	snap := a.snapshot(t0.Add(120 * time.Second))
	for i, v := range snap {
		if v != 0 {
			t.Fatalf("snap[%d]=%d want 0 (aged out)", i, v)
		}
	}
}

// A gap larger than the window between two records must wipe stale
// data — the new record starts a fresh window.
func TestActivityRing_GapWipes(t *testing.T) {
	var a activityRing
	t0 := time.Unix(5_000_000, 0)
	a.record(t0, 7)
	a.record(t0.Add(120*time.Second), 11)
	snap := a.snapshot(t0.Add(120 * time.Second))
	if snap[59] != 11 {
		t.Fatalf("snap[59]=%d want 11", snap[59])
	}
	for i := 0; i < 59; i++ {
		if snap[i] != 0 {
			t.Fatalf("snap[%d]=%d want 0 after gap wipe", i, snap[i])
		}
	}
}

// Session.Activity must be safe to call concurrently with a writer that
// holds s.mu via record. Drives the snapshot reader and a write loop in
// parallel and lets `go test -race` catch any UB.
func TestSession_ActivityRace(t *testing.T) {
	s := &Session{
		ring: newRing(1024),
	}
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		now := time.Now()
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			s.mu.Lock()
			s.activity.record(now.Add(time.Duration(i)*time.Millisecond), 8)
			s.mu.Unlock()
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 5000; i++ {
			select {
			case <-stop:
				return
			default:
			}
			_ = s.Activity()
		}
	}()
	time.Sleep(50 * time.Millisecond)
	close(stop)
	wg.Wait()
}
