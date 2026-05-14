// c2-server hosts the local HTTP+WS bridge between the browser xterm.js
// client and a pool of `claude --resume <uuid>` PTYs. See GUI-DESIGN.md
// Phase 2 for the architecture.
//
// Binds strictly to 127.0.0.1 on a random OS-assigned port. Writes the
// chosen port + pid to ~/.local/share/cc/server.port for `cc gui` to
// discover (and to detect duplicate launches). On signal, kills all live
// PTYs and removes the discovery file.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"c2/adapters/archivejson"
	"c2/core"
	"c2/core/usecase"
	"c2/internal/ptymgr"
	"c2/internal/webdev"

	"github.com/coder/websocket"
)

var (
	store   = archivejson.New()
	manager = ptymgr.New()
	webFS   = webdev.FS()
)

// portFileCleanup is installed by run() once the discovery file exists,
// so a top-level panic recover can still remove it. Defers inside run()
// cover the normal path; this is the belt-and-braces case where a panic
// (possibly from a non-main goroutine after being recovered into main)
// would otherwise leave a stale ~/.local/share/cc/server.port behind.
var portFileCleanup func()

func main() {
	defer func() {
		if r := recover(); r != nil {
			if portFileCleanup != nil {
				portFileCleanup()
			}
			panic(r)
		}
	}()
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "c2-server:", err)
		os.Exit(1)
	}
}

func run() error {
	// 1. Discovery file. If a previous server is still alive, don't spawn
	//    a duplicate — print its URL and exit 0 so `cc gui` can just open
	//    the browser.
	portFile, err := portFilePath()
	if err != nil {
		return err
	}
	if existing, alive := readAlivePort(portFile); alive {
		fmt.Fprintf(os.Stderr, "c2-server: already running at http://127.0.0.1:%d\n", existing)
		fmt.Printf("http://127.0.0.1:%d\n", existing)
		return nil
	}

	// 2. Bind 127.0.0.1:0 — strict loopback, OS picks the port.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port

	if err := writePortFile(portFile, port); err != nil {
		ln.Close()
		return err
	}
	cleanupPortFile := func() { _ = os.Remove(portFile) }
	portFileCleanup = cleanupPortFile // for the top-level panic recover in main
	defer cleanupPortFile()

	originHost := fmt.Sprintf("127.0.0.1:%d", port)
	originHostAlt := fmt.Sprintf("localhost:%d", port)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/sessions", handleSessions)
	mux.HandleFunc("/api/sessions/", routeSession(originHost, originHostAlt))
	mux.HandleFunc("/assets/", handleAssets)
	mux.HandleFunc("/", handleIndex)

	srv := &http.Server{
		Handler:      mux,
		ReadTimeout:  0, // websockets need long-lived connections
		WriteTimeout: 0,
	}

	// 4. Signal handler: gracefully shut HTTP down, kill all PTYs, remove
	//    discovery file.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// idleTimeout: shut the server down after this much continuous
	// inactivity (zero live PTYs AND zero attached clients). 0 disables.
	idleTimeout := idleTimeoutFromEnv()
	idleCtx, idleCancel := context.WithCancel(context.Background())
	defer idleCancel()
	idleTriggered := make(chan struct{})
	if idleTimeout > 0 {
		fmt.Fprintf(os.Stderr, "c2-server: idle watchdog: shutdown after %d minutes of inactivity\n",
			int(idleTimeout.Minutes()))
		startIdleWatcher(idleCtx, manager, idleTimeout, idleTriggered)
	} else {
		fmt.Fprintln(os.Stderr, "c2-server: idle watchdog disabled (C2_SERVER_IDLE_MINUTES=0)")
	}

	go func() {
		select {
		case <-ctx.Done():
			fmt.Fprintln(os.Stderr, "c2-server: shutting down")
		case <-idleTriggered:
			fmt.Fprintf(os.Stderr, "c2-server: idle: shutting down after %d minutes of inactivity\n",
				int(idleTimeout.Minutes()))
		}
		shutCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
		manager.KillAll()
	}()

	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	fmt.Fprintf(os.Stderr, "c2-server: listening on %s (pid %d)\n", url, os.Getpid())
	fmt.Println(url) // stdout: machine-readable for callers like `cc gui`

	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

func handleSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	f, err := store.Load()
	if err != nil {
		httpError(w, err, http.StatusInternalServerError)
		return
	}
	writeJSON(w, f.ListActive())
}

// routeSession dispatches /api/sessions/:id and /api/sessions/:id/{archive,pty}.
// Kept hand-rolled rather than pulling in a router — only three patterns.
func routeSession(originHost, originHostAlt string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/api/sessions/")
		parts := strings.SplitN(rest, "/", 2)
		if len(parts) == 0 || parts[0] == "" {
			http.NotFound(w, r)
			return
		}
		id := parts[0]
		sub := ""
		if len(parts) == 2 {
			sub = parts[1]
		}
		switch sub {
		case "":
			handleSessionGet(w, r, id)
		case "archive":
			if !checkSameOrigin(w, r, originHost, originHostAlt) {
				return
			}
			handleSessionArchive(w, r, id)
		case "pty":
			handleSessionPTY(w, r, id, originHost, originHostAlt)
		default:
			http.NotFound(w, r)
		}
	}
}

// checkSameOrigin guards state-changing REST routes against cross-origin
// drive-by POST. Loopback binding alone doesn't help here: any page the
// user opens in the same browser can `fetch('http://127.0.0.1:PORT/...',
// {method:'POST', mode:'no-cors'})` and the request goes through. We
// require Origin to match one of our advertised hosts; missing Origin
// (curl, non-browser clients) is also allowed because they don't have
// the CSRF surface.
func checkSameOrigin(w http.ResponseWriter, r *http.Request, originHost, originHostAlt string) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return true
	}
	want1 := "http://" + originHost
	want2 := "http://" + originHostAlt
	if o == want1 || o == want2 {
		return true
	}
	http.Error(w, "cross-origin not allowed", http.StatusForbidden)
	return false
}

func handleSessionGet(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	f, err := store.Load()
	if err != nil {
		httpError(w, err, http.StatusInternalServerError)
		return
	}
	e := f.Find(id)
	if e == nil {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, e)
}

func handleSessionArchive(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_, archived, err := usecase.ToggleArchive(store, id)
	if err != nil {
		httpError(w, err, http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]bool{"archived": archived})
}

func handleSessionPTY(w http.ResponseWriter, r *http.Request, id, originHost, originHostAlt string) {
	// 1. Look up the entry so we know cwd + claude uuid. The URL path
	//    carries the c2-internal id (8 hex chars), the same key REST
	//    routes use. The pty manager keys by ClaudeUUID internally; we
	//    resolve that here.
	f, err := store.Load()
	if err != nil {
		httpError(w, err, http.StatusInternalServerError)
		return
	}
	e := f.Find(id)
	if e == nil {
		http.NotFound(w, r)
		return
	}
	if e.ClaudeUUID == "" {
		http.Error(w, "session has no claude uuid yet", http.StatusConflict)
		return
	}

	// 2. Accept the WS, restricting origin to our own loopback URL. Local-only
	//    binding alone doesn't protect us from drive-by cross-origin WS from
	//    a webpage the user opens in the same browser; origin check does.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{originHost, originHostAlt},
	})
	if err != nil {
		// websocket.Accept already wrote an error response.
		return
	}
	// Per coder/websocket: must call CloseNow on exit if not gracefully closed.
	defer conn.CloseNow()

	// Bound each frame to 64 KB. Stdin from a keyboard is tiny; control
	// frames are small JSON; this protects against a misbehaving client
	// (or a compromised same-browser tab past the origin check) flooding
	// memory before WriteStdin pushes back on the PTY.
	conn.SetReadLimit(64 * 1024)

	client := newWSClient(conn)
	sess, err := manager.Attach(e.ClaudeUUID, e.CWD, client)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pty[%s]: attach failed: %v\n", id, err)
		_ = client.WriteControl(map[string]any{"type": "error", "message": err.Error()})
		_ = conn.Close(websocket.StatusInternalError, "attach failed")
		return
	}
	defer manager.Detach(sess, client)

	// 3. Read loop: forward binary frames as stdin, text frames as control.
	ctx := r.Context()
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			// Normal close or transport error; either way we detach.
			return
		}
		switch typ {
		case websocket.MessageBinary:
			if werr := sess.WriteStdin(data); werr != nil {
				_ = conn.Close(websocket.StatusInternalError, "stdin write failed")
				return
			}
		case websocket.MessageText:
			handleControl(sess, conn, data)
		}
	}
}

func handleControl(sess *ptymgr.Session, conn *websocket.Conn, data []byte) {
	var msg struct {
		Type string `json:"type"`
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		return // ignore garbage
	}
	switch msg.Type {
	case "resize":
		_ = sess.Resize(msg.Cols, msg.Rows)
	case "kill":
		_ = sess.Kill()
		_ = conn.Close(websocket.StatusNormalClosure, "killed")
	}
}

// ---------------------------------------------------------------------------
// Static
// ---------------------------------------------------------------------------

// assetsHandler serves the embedded webdev FS at / and /assets/*.
// The whole subtree (index.html plus any future assets) ships inside
// the binary via internal/webdev/embed.go.
var assetsHandler = http.FileServer(http.FS(webFS))

func handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	assetsHandler.ServeHTTP(w, r)
}

func handleAssets(w http.ResponseWriter, r *http.Request) {
	// http.FileServer expects the request path to be the FS path; ours
	// already starts with /assets/ which matches the on-disk layout.
	assetsHandler.ServeHTTP(w, r)
}

// ---------------------------------------------------------------------------
// Discovery file (~/.local/share/cc/server.port)
// ---------------------------------------------------------------------------

func portFilePath() (string, error) {
	if d := os.Getenv("XDG_DATA_HOME"); d != "" {
		return filepath.Join(d, "cc", "server.port"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "share", "cc", "server.port"), nil
}

// readAlivePort returns the recorded port if the recorded pid is alive,
// otherwise removes the stale file and returns false.
func readAlivePort(path string) (int, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) < 2 {
		_ = os.Remove(path)
		return 0, false
	}
	port, err := strconv.Atoi(strings.TrimSpace(lines[0]))
	if err != nil {
		_ = os.Remove(path)
		return 0, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(lines[1]))
	if err != nil {
		_ = os.Remove(path)
		return 0, false
	}
	// kill -0 probe.
	proc, err := os.FindProcess(pid)
	if err != nil {
		_ = os.Remove(path)
		return 0, false
	}
	if err := proc.Signal(syscall.Signal(0)); err != nil {
		_ = os.Remove(path)
		return 0, false
	}
	return port, true
}

func writePortFile(path string, port int) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	content := fmt.Sprintf("%d\n%d\n", port, os.Getpid())
	return os.WriteFile(path, []byte(content), 0o644)
}

// ---------------------------------------------------------------------------
// WS client adapter — implements ptymgr.Client over a coder/websocket conn.
// ---------------------------------------------------------------------------

type wsClient struct {
	conn   *websocket.Conn
	writeMu sync.Mutex // serialize writes; coder/websocket requires it
	closed  bool
}

func newWSClient(c *websocket.Conn) *wsClient { return &wsClient{conn: c} }

func (c *wsClient) WriteBytes(p []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closed {
		return io.ErrClosedPipe
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return c.conn.Write(ctx, websocket.MessageBinary, p)
}

func (c *wsClient) WriteControl(v any) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closed {
		return io.ErrClosedPipe
	}
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return c.conn.Write(ctx, websocket.MessageText, b)
}

func (c *wsClient) Close() error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closed {
		return nil
	}
	c.closed = true
	return c.conn.Close(websocket.StatusNormalClosure, "")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		// Body partially written — best we can do is log.
		fmt.Fprintln(os.Stderr, "c2-server: write json:", err)
	}
}

func httpError(w http.ResponseWriter, err error, code int) {
	http.Error(w, err.Error(), code)
}

// Ensure core import isn't dropped — needed for ToggleArchive's return type.
var _ = core.C2Entry{}

// ---------------------------------------------------------------------------
// Idle auto-shutdown
// ---------------------------------------------------------------------------

// idleCheckInterval is how often the watchdog polls manager state. Kept
// short relative to the timeout so the granularity error is small but
// long enough not to busy-loop.
const idleCheckInterval = 30 * time.Second

// idleTimeoutFromEnv reads C2_SERVER_IDLE_MINUTES. Default 15 minutes,
// 0 disables the watchdog.
func idleTimeoutFromEnv() time.Duration {
	v := os.Getenv("C2_SERVER_IDLE_MINUTES")
	if v == "" {
		return 15 * time.Minute
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n < 0 {
		fmt.Fprintf(os.Stderr, "c2-server: warn: invalid C2_SERVER_IDLE_MINUTES=%q, using default\n", v)
		return 15 * time.Minute
	}
	return time.Duration(n) * time.Minute
}

// startIdleWatcher polls the manager for activity and closes `fire` when
// the system has been idle (0 PTYs AND 0 clients) continuously for
// `timeout`. The manager's activity hook resets the "last active" mark
// AND bumps a generation counter whenever an attach/detach/GC happens.
//
// Invariant: `fire` is closed only if, under a single critical section,
// (a) Count==0, (b) AttachedCount==0, (c) the generation observed at the
// start of the check has not changed, AND (d) elapsed >= timeout. This
// closes the TOCTOU window where an Attach() could complete between our
// state check and the close(fire) — the bumped generation forces the
// next tick to reset waiting instead of firing.
func startIdleWatcher(ctx context.Context, m *ptymgr.Manager, timeout time.Duration, fire chan struct{}) {
	var (
		mu         sync.Mutex
		lastActive = time.Now()
		gen        uint64 // monotonic activity counter
	)
	bump := func() {
		mu.Lock()
		lastActive = time.Now()
		gen++
		mu.Unlock()
	}
	m.SetActivityHook(bump)

	go func() {
		t := time.NewTicker(idleCheckInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				// Snapshot the generation BEFORE inspecting manager state.
				// If a concurrent Attach bumps gen after this read, the
				// recheck below will see the mismatch and abort the fire.
				mu.Lock()
				startGen := gen
				mu.Unlock()

				if m.Count() > 0 || m.AttachedCount() > 0 {
					bump() // active right now; keep extending
					continue
				}

				// Recheck under the lock that both state and generation
				// agree we are (still) idle. Without this, an Attach
				// completing between the AttachedCount() read and the
				// close(fire) below would kill the freshly spawned PTY.
				mu.Lock()
				elapsed := time.Since(lastActive)
				stillIdle := gen == startGen && m.Count() == 0 && m.AttachedCount() == 0
				mu.Unlock()
				if stillIdle && elapsed >= timeout {
					close(fire)
					return
				}
			}
		}
	}()
}
