// c3-server hosts the local HTTP+WS bridge between the browser xterm.js
// client and a pool of `claude --resume <uuid>` PTYs. See GUI-DESIGN.md
// Phase 2 for the architecture.
//
// Binds strictly to 127.0.0.1. Default port depends on build mode:
// installed builds (ldflag override) use 7755; source builds use a
// random OS-assigned port. C3_SERVER_PORT overrides either. Writes
// the chosen port + pid to ~/.local/share/c3/server.port for
// `c3 gui` to discover (and to detect duplicate launches). On
// signal, kills all live PTYs and removes the discovery file.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
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

	"github.com/binhsonnguyen/ccc/adapters/archivejson"
	"github.com/binhsonnguyen/ccc/adapters/claudefs"
	"github.com/binhsonnguyen/ccc/adapters/ptyrunner"
	"github.com/binhsonnguyen/ccc/core"
	"github.com/binhsonnguyen/ccc/core/usecase"
	"github.com/binhsonnguyen/ccc/internal/provider"
	"github.com/binhsonnguyen/ccc/internal/ptymgr"
	"github.com/binhsonnguyen/ccc/internal/webdev"

	"github.com/coder/websocket"
)

var (
	store     = archivejson.New()
	manager   = ptymgr.New()
	claudeFS  = claudefs.New()
	webFS     = webdev.FS()
	providers = provider.New()
)

// version is set at build time via -ldflags "-X main.version=…".
// "dev" is the default for plain `go build`; release binaries
// (Makefile install, install.sh, goreleaser) set the semver tag.
var version = "dev"

// portFileCleanup is installed by run() once the discovery file exists,
// so a top-level panic recover can still remove it. Defers inside run()
// cover the normal path; this is the belt-and-braces case where a panic
// (possibly from a non-main goroutine after being recovered into main)
// would otherwise leave a stale ~/.local/share/c3/server.port behind.
var portFileCleanup func()

func main() {
	for _, a := range os.Args[1:] {
		if a == "-v" || a == "--version" {
			fmt.Println(version)
			return
		}
	}
	defer func() {
		if r := recover(); r != nil {
			if portFileCleanup != nil {
				portFileCleanup()
			}
			panic(r)
		}
	}()
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "c3-server:", err)
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
		fmt.Fprintf(os.Stderr, "c3-server: already running at http://127.0.0.1:%d\n", existing)
		fmt.Printf("http://127.0.0.1:%d\n", existing)
		return nil
	}

	// 2. Bind 127.0.0.1:<port>. Installed builds default to a fixed
	//    port (7755) so the URL stays bookmarkable across launches;
	//    source builds default to 0 (random OS-assigned) so dev/debug
	//    against multiple checkouts doesn't collide. C3_SERVER_PORT
	//    overrides either way; =0 forces random.
	requestedPort := portFromEnv()
	addr := fmt.Sprintf("127.0.0.1:%d", requestedPort)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		if requestedPort != 0 {
			return fmt.Errorf("listen %s: %w\nhint: set C3_SERVER_PORT=0 for a random port, or pick another", addr, err)
		}
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

	// Inject the active LLM-provider profile (Anthropic / DeepSeek / …) into
	// every spawned claude PTY. Read fresh per spawn inside ptyrunner, so a
	// UI toggle applies to the next session without a daemon restart. A nil
	// overlay (no active profile) is the original thin-wrapper passthrough.
	ptyrunner.EnvOverlay = providers.Overlay

	// Wire the discovery → bind hook BEFORE we accept any WS attach.
	// When a pending session's uuid surfaces in claudefs, PATCH the c3
	// entry so subsequent /api/sessions list reflects the link.
	manager.SetUUIDDiscoveredHook(func(sessionKey, newUUID string) {
		if _, err := usecase.Bind(store, sessionKey, newUUID); err != nil {
			fmt.Fprintf(os.Stderr, "c3-server: discovery bind %s → %s failed: %v\n",
				sessionKey, newUUID, err)
		} else {
			fmt.Fprintf(os.Stderr, "c3-server: discovery: %s → %s\n",
				sessionKey, shortUUID(newUUID))
		}
	})

	mux := http.NewServeMux()
	mux.HandleFunc("/api/sessions/search", handleSessionsSearch)
	mux.HandleFunc("/api/sessions", handleSessionsCollection(originHost, originHostAlt))
	mux.HandleFunc("/api/sessions/", routeSession(originHost, originHostAlt))
	mux.HandleFunc("/api/claude-sessions", handleClaudeSessions)
	mux.HandleFunc("/api/layout", handleLayout(originHost, originHostAlt))
	mux.HandleFunc("/api/sidebar-layout", handleSidebarLayout(originHost, originHostAlt))
	mux.HandleFunc("/api/providers", handleProviders(originHost, originHostAlt))
	mux.HandleFunc("/api/providers/", handleProvidersSub(originHost, originHostAlt))
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
		fmt.Fprintf(os.Stderr, "c3-server: idle watchdog: shutdown after %d minutes of inactivity\n",
			int(idleTimeout.Minutes()))
		startIdleWatcher(idleCtx, manager, idleTimeout, idleTriggered)
	} else {
		fmt.Fprintln(os.Stderr, "c3-server: idle watchdog disabled (C3_SERVER_IDLE_MINUTES=0)")
	}

	go func() {
		select {
		case <-ctx.Done():
			fmt.Fprintln(os.Stderr, "c3-server: shutting down")
		case <-idleTriggered:
			fmt.Fprintf(os.Stderr, "c3-server: idle: shutting down after %d minutes of inactivity\n",
				int(idleTimeout.Minutes()))
		}
		shutCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
		manager.KillAll()
	}()

	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	fmt.Fprintf(os.Stderr, "c3-server: listening on %s (pid %d, %s build)\n", url, os.Getpid(), portMode())
	fmt.Println(url) // stdout: machine-readable for callers like `cc gui`

	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

// handleSessionsCollection serves /api/sessions:
//   - GET: list active (or archived with ?archived=true), optionally with
//     per-entry `live` field (?include=live).
//   - POST: create a new pending entry from {cwd, name}. CSRF-guarded.
func handleSessionsCollection(originHost, originHostAlt string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			handleListSessions(w, r)
		case http.MethodPost:
			if !checkSameOrigin(w, r, originHost, originHostAlt) {
				return
			}
			handleCreateSession(w, r)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

func handleListSessions(w http.ResponseWriter, r *http.Request) {
	f, err := store.Load()
	if err != nil {
		httpError(w, err, http.StatusInternalServerError)
		return
	}
	archived := r.URL.Query().Get("archived") == "true"
	includeLive := r.URL.Query().Get("include") == "live"

	var entries []core.C3Entry
	if archived {
		entries = f.ListArchived()
	} else {
		entries = f.ListActive()
	}

	if !includeLive {
		writeJSON(w, entries)
		return
	}
	// Anonymous struct: embeds C3Entry plus a `live` boolean. Marshalled
	// JSON ends up with `live` as a sibling field thanks to the embedded
	// promotion + anonymous wrapper.
	type entryWithLive struct {
		core.C3Entry
		Live bool `json:"live"`
	}
	out := make([]entryWithLive, 0, len(entries))
	for _, e := range entries {
		// Shell entries have ClaudeUUID == "" forever — HasUUID would
		// never match. The PTY for a shell tab is keyed by c3 id in the
		// manager, so check HasKey(e.ID) too.
		live := manager.HasUUID(e.ClaudeUUID)
		if !live && e.IsShell() {
			live = manager.HasKey(e.ID)
		}
		out = append(out, entryWithLive{C3Entry: e, Live: live})
	}
	writeJSON(w, out)
}

func handleCreateSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CWD         string   `json:"cwd"`
		Name        string   `json:"name"`
		FirstPrompt string   `json:"firstPrompt"`
		ClaudeUUID  string   `json:"claudeUuid"`
		Kind        string   `json:"kind"`    // "" or "shell"
		Command     []string `json:"command"` // shell-only argv override; nil ⇒ default
		// commandPresent: was the JSON field actually present (true) or
		// just absent / null (false)? Go's default decoder collapses both
		// into nil so we can't tell empty-array from missing without a
		// raw round-trip. Below we re-decode into a map[string]any to
		// detect [].
	}
	// First-pass decode for typed fields.
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "read body", http.StatusBadRequest)
		return
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	// Detect command: [] explicitly (vs. absent / null). Reject so the
	// invariant "Command nil ⇒ default; Command non-nil ⇒ exact argv"
	// stays usable — an empty argv would crash exec.LookPath downstream
	// and is never what the caller meant.
	{
		var probe map[string]json.RawMessage
		if json.Unmarshal(raw, &probe) == nil {
			if rawCmd, ok := probe["command"]; ok {
				var arr []string
				if json.Unmarshal(rawCmd, &arr) == nil && arr != nil && len(arr) == 0 {
					http.Error(w, "validation failed: command must be non-empty when set", http.StatusBadRequest)
					return
				}
			}
		}
	}

	switch body.Kind {
	case "", "claude":
		// Edge case (counter-review #3): a client-supplied uuid without a
		// firstPrompt would force `claude --resume <uuid>` against a uuid
		// claude has never seen → spawn error. Quietly drop the uuid in that
		// case and fall back to the pending flow.
		uuid := strings.TrimSpace(body.ClaudeUUID)
		firstPrompt := body.FirstPrompt
		if uuid != "" && firstPrompt == "" {
			uuid = ""
		}
		if uuid != "" && !usecase.IsValidUUID(uuid) {
			http.Error(w, "validation failed: claudeUuid is not a valid uuid", http.StatusBadRequest)
			return
		}
		entry, err := usecase.NewEntry(store, body.CWD, body.Name, uuid)
		if err != nil {
			mapUsecaseError(w, err)
			return
		}
		// Stash the prompt BEFORE returning so a fast client (POST →
		// immediate WS attach) finds it when Attach runs.
		if entry.ClaudeUUID != "" && firstPrompt != "" {
			manager.SetFirstPrompt(entry.ClaudeUUID, firstPrompt)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(entry)

	case "shell":
		// Shell branch: ignore firstPrompt / claudeUuid even if present
		// (they have no meaning here). Reuse usecase-style validation by
		// hand because NewEntry is claude-shaped.
		entry, err := createShellEntry(body.CWD, body.Name, body.Command)
		if err != nil {
			mapUsecaseError(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(entry)

	default:
		http.Error(w, "validation failed: unknown kind "+body.Kind, http.StatusBadRequest)
	}
}

// createShellEntry validates and persists a new shell c3-session.
// Mirrors usecase.NewEntry's invariants (absolute cwd, exists, is dir,
// name non-empty + bounded) but writes Kind=shell + Command instead of
// going through the claude path.
func createShellEntry(cwd, name string, argv []string) (core.C3Entry, error) {
	if !filepath.IsAbs(cwd) {
		return core.C3Entry{}, fmt.Errorf("%w: cwd must be absolute, got %q", usecase.ErrValidation, cwd)
	}
	info, err := os.Stat(cwd)
	if err != nil {
		return core.C3Entry{}, fmt.Errorf("%w: cwd: %v", usecase.ErrValidation, err)
	}
	if !info.IsDir() {
		return core.C3Entry{}, fmt.Errorf("%w: cwd is not a directory: %s", usecase.ErrValidation, cwd)
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = filepath.Base(cwd)
	}
	if name == "" {
		return core.C3Entry{}, fmt.Errorf("%w: name is empty", usecase.ErrValidation)
	}
	if argv != nil && len(argv) == 0 {
		// Belt-and-braces — handler should have caught this.
		return core.C3Entry{}, fmt.Errorf("%w: command must be non-empty when set", usecase.ErrValidation)
	}
	var created core.C3Entry
	err = store.Mutate(func(f *core.ArchiveFile) error {
		created = f.AddShellEntry(name, cwd, argv)
		return nil
	})
	if err != nil {
		return core.C3Entry{}, err
	}
	return created, nil
}

// mapUsecaseError translates usecase sentinels into HTTP status codes.
func mapUsecaseError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, usecase.ErrNotFound):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, usecase.ErrPTYLive), errors.Is(err, usecase.ErrAlreadyBound):
		http.Error(w, err.Error(), http.StatusConflict)
	case errors.Is(err, usecase.ErrValidation):
		http.Error(w, err.Error(), http.StatusBadRequest)
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
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
			// GET (read one), PATCH (rename), DELETE (remove). Mutating
			// methods are CSRF-guarded.
			switch r.Method {
			case http.MethodGet:
				handleSessionGet(w, r, id)
			case http.MethodPatch:
				if !checkSameOrigin(w, r, originHost, originHostAlt) {
					return
				}
				handleSessionPatch(w, r, id)
			case http.MethodDelete:
				if !checkSameOrigin(w, r, originHost, originHostAlt) {
					return
				}
				handleSessionDelete(w, r, id)
			default:
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			}
		case "archive":
			if !checkSameOrigin(w, r, originHost, originHostAlt) {
				return
			}
			handleSessionArchive(w, r, id)
		case "bind":
			if !checkSameOrigin(w, r, originHost, originHostAlt) {
				return
			}
			handleSessionBind(w, r, id)
		case "pty":
			handleSessionPTY(w, r, id, originHost, originHostAlt)
		case "tail":
			handleSessionTail(w, r, id)
		case "activity":
			handleSessionActivity(w, r, id)
		case "upload-image":
			if !checkSameOrigin(w, r, originHost, originHostAlt) {
				return
			}
			handleUploadImage(w, r, id)
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

func handleSessionPatch(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	entry, err := usecase.Rename(store, id, body.Name)
	if err != nil {
		mapUsecaseError(w, err)
		return
	}
	writeJSON(w, entry)
}

func handleSessionDelete(w http.ResponseWriter, r *http.Request, id string) {
	force := r.URL.Query().Get("force") == "1" || r.URL.Query().Get("force") == "true"
	if err := usecase.Remove(store, id, force, manager); err != nil {
		mapUsecaseError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func handleSessionBind(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		ClaudeUUID string `json:"claudeUuid"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	entry, err := usecase.Bind(store, id, body.ClaudeUUID)
	if err != nil {
		mapUsecaseError(w, err)
		return
	}
	writeJSON(w, entry)
}

// handleSessionTail returns the tail of a session's PTY scrollback
// ring buffer as raw text/plain bytes (ANSI escapes preserved — the
// client strips them for preview rendering). Returns 204 when there
// is no live PTY (so no buffer). GET only, no CSRF surface.
//
// Query: ?bytes=N (default 8192, clamped 256..32768).
func handleSessionTail(w http.ResponseWriter, r *http.Request, id string) {
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
	// Look up the live PTY. Pending entries (no claudeUuid) are keyed
	// by c3 id; bound entries by claude uuid. Try uuid first, fall
	// back to c3 id for the pending case.
	var sess *ptymgr.Session
	if e.ClaudeUUID != "" {
		sess = manager.GetSessionByUUID(e.ClaudeUUID)
	}
	if sess == nil {
		sess = manager.GetSession(e.ID)
	}
	if sess == nil {
		// No live PTY → no scrollback to return.
		w.WriteHeader(http.StatusNoContent)
		return
	}
	n := 0
	if q := r.URL.Query().Get("bytes"); q != "" {
		if v, err := strconv.Atoi(q); err == nil {
			n = v
		}
	}
	tail := sess.TailBytes(n) // method clamps
	if len(tail) == 0 {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(tail)
}

// handleSessionActivity returns the 60-bucket bytes/sec ring for a live
// session as JSON: {"buckets":[…60 ints, oldest first]}. Returns 204
// when no live PTY exists (mirrors the tail endpoint). GET only, no
// CSRF surface; Cache-Control: no-store so the sidebar's 2s polling
// always sees fresh data.
func handleSessionActivity(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Polling-style endpoint — never cache, regardless of the response
	// shape. Set the header up front so the 204 path inherits it.
	w.Header().Set("Cache-Control", "no-store")
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
	var sess *ptymgr.Session
	if e.ClaudeUUID != "" {
		sess = manager.GetSessionByUUID(e.ClaudeUUID)
	}
	if sess == nil {
		sess = manager.GetSession(e.ID)
	}
	if sess == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	snap := sess.Activity()
	idleMs := sess.IdleMillis()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"buckets": snap[:],
		"idleMs":  idleMs,
	})
}

// handleUploadImage saves one or more pasted/dragged image blobs to a
// per-session subdir under /tmp and returns their absolute paths. The
// web client injects "@<path> " into the PTY stdin so claude sees a
// normal @mention — claude reads the file at send-time and uploads the
// bytes; after that the on-disk copy is ephemeral, so /tmp is the
// right home (OS reclaims it on reboot, no cleanup-on-delete needed).
//
// No size cap by design (user runs c3 locally; we trust the source).
// ParseMultipartForm keeps ≤32 MB in memory and spools the rest to a
// tmpfile, so a huge paste won't OOM the server.
func handleUploadImage(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		http.Error(w, "invalid multipart: "+err.Error(), http.StatusBadRequest)
		return
	}
	files := r.MultipartForm.File["image"]
	if len(files) == 0 {
		http.Error(w, "no image files in 'image' field", http.StatusBadRequest)
		return
	}
	f, err := store.Load()
	if err != nil {
		httpError(w, err, http.StatusInternalServerError)
		return
	}
	if f.Find(id) == nil {
		http.NotFound(w, r)
		return
	}
	dir := sessionImageDir(id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		httpError(w, err, http.StatusInternalServerError)
		return
	}
	paths := make([]string, 0, len(files))
	for _, fh := range files {
		name := fmt.Sprintf("image-%s%s", randomToken(8), extForUpload(fh))
		outPath := filepath.Join(dir, name)
		if err := saveUpload(fh, outPath); err != nil {
			httpError(w, err, http.StatusInternalServerError)
			return
		}
		paths = append(paths, outPath)
	}
	writeJSON(w, map[string]any{"paths": paths})
}

func saveUpload(fh *multipart.FileHeader, outPath string) error {
	src, err := fh.Open()
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.Create(outPath)
	if err != nil {
		return err
	}
	defer dst.Close()
	_, err = io.Copy(dst, src)
	return err
}

func extForUpload(fh *multipart.FileHeader) string {
	switch fh.Header.Get("Content-Type") {
	case "image/png":
		return ".png"
	case "image/jpeg", "image/jpg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	case "image/heic":
		return ".heic"
	case "image/svg+xml":
		return ".svg"
	}
	if e := strings.ToLower(filepath.Ext(fh.Filename)); e != "" {
		return e
	}
	return ".bin"
}

func randomToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// sessionImageDir is the on-disk directory for a session's pasted
// images: <tmp>/c3/<id>/images. Tmp is OS-defined (os.TempDir() →
// /tmp on Linux, /var/folders/... on macOS); either way the kernel
// reclaims it on reboot. Per-id subdir keeps multi-session listings
// distinguishable for debugging.
func sessionImageDir(id string) string {
	return filepath.Join(os.TempDir(), "c3", id, "images")
}

// handleClaudeSessions returns the bind dialog's data set: unbound claude
// sessions (uuids not yet adopted by any c3 entry) plus a deduped cwd
// recency list across both c3 entries and Claude's raw storage.
func handleClaudeSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ss, err := claudeFS.Scan()
	if err != nil {
		httpError(w, err, http.StatusInternalServerError)
		return
	}
	f, err := store.Load()
	if err != nil {
		httpError(w, err, http.StatusInternalServerError)
		return
	}
	unbound := f.UnboundClaudeSessions(ss)

	// Merge cwds: c3-entry cwds first (ListAll preserves CreatedAt-desc
	// order), then claudefs cwds. Dedup keeping first occurrence.
	seen := map[string]bool{}
	var cwds []string
	for _, e := range f.ListAll() {
		if e.CWD == "" || seen[e.CWD] {
			continue
		}
		seen[e.CWD] = true
		cwds = append(cwds, e.CWD)
	}
	for _, s := range ss {
		if s.Sidechain || s.CWD == "" || seen[s.CWD] {
			continue
		}
		seen[s.CWD] = true
		cwds = append(cwds, s.CWD)
	}
	writeJSON(w, map[string]any{
		"unbound": unbound,
		"cwds":    cwds,
	})
}

// handleSessionsSearch grep-streams Claude JSONL files for a case-insensitive
// substring match of ?q=. GET only, no CSRF surface (read-only). Returns
// {matches:[{claudeUuid,cwd,snippet,matchedAt}], truncated:bool}. The
// concrete adapter call is used directly (no port abstraction) because
// search is server-only — core/usecase has no reason to depend on it.
func handleSessionsSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	q := r.URL.Query().Get("q")
	limit := 0
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}
	matches, truncated, err := claudeFS.Search(q, limit)
	if err != nil {
		if _, ok := err.(claudefs.ErrQueryTooShort); ok {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		httpError(w, err, http.StatusInternalServerError)
		return
	}
	if matches == nil {
		matches = []claudefs.SearchMatch{}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, map[string]any{
		"matches":   matches,
		"truncated": truncated,
	})
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
	//    carries the c3-internal id (8 hex chars), the same key REST
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
	// Pending-uuid path: key by c3 id, spawn claude (no resume), let the
	// discovery loop fill in the uuid later (D-7).
	// Shell path: ALWAYS key by c3 id (claudeUuid is "" forever for
	// shell). Note (v1 trade-off): shell PTY does not survive server
	// crash; a reattach after restart re-spawns a fresh shell with empty
	// scrollback. Acceptable in v1; "overlay-with-restart" option deferred
	// until users complain.
	sessionKey := e.ClaudeUUID
	if sessionKey == "" {
		sessionKey = e.ID
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
	spec := ptymgr.SpawnSpec{
		Kind:       "claude",
		CWD:        e.CWD,
		ClaudeUUID: e.ClaudeUUID,
	}
	if e.IsShell() {
		spec = ptymgr.SpawnSpec{
			Kind: "shell",
			CWD:  e.CWD,
			Argv: e.Command,
		}
	}
	sess, err := manager.AttachSpec(sessionKey, spec, client)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pty[%s]: attach failed: %v\n", id, err)
		_ = client.WriteControl(map[string]any{"type": "error", "message": err.Error()})
		_ = conn.Close(websocket.StatusInternalError, "attach failed")
		return
	}
	defer manager.Detach(sess, client)

	// 3. Read loop: forward binary frames as stdin, text frames as control.
	ctx := r.Context()

	// Keepalive: ping every 20 s so we detect zombie connections (e.g.
	// after laptop sleep) before the TCP timeout fires. coder/websocket
	// Ping() blocks until pong arrives or ctx is cancelled; a dead conn
	// will cause Ping to error, which we ignore here — the concurrent
	// Read() will also error and exit the read loop cleanly.
	go func() {
		t := time.NewTicker(20 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				_ = conn.Ping(ctx)
			}
		}
	}()

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
// Discovery file (~/.local/share/c3/server.port)
// ---------------------------------------------------------------------------

func portFilePath() (string, error) {
	if d := os.Getenv("XDG_DATA_HOME"); d != "" {
		return filepath.Join(d, "c3", "server.port"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "share", "c3", "server.port"), nil
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
// Split-panel layout sidecar (v0.2.23)
// ---------------------------------------------------------------------------
//
// GET /api/layout → 200 with the stored JSON body, or 204 when no file
// PUT /api/layout → 204 after atomic write (tempfile + rename). Body is
//                   capped at 64 KiB and parsed as opaque JSON; the
//                   server only validates "is a JSON object", never the
//                   v1 schema. Client (web/src/lib/layout.ts) is the
//                   single source of schema knowledge so v2 won't need
//                   a server change.
//
// File path: $XDG_DATA_HOME/c3/layout.json, fallback ~/.local/share/c3/layout.json.

const layoutMaxBytes = 64 * 1024

func layoutFilePath() (string, error) {
	return dataFilePath("layout.json")
}

// sidebarLayoutFilePath is the sidecar for the sidebar's session ordering and
// channel grouping (web/src/lib/sidebarLayout.ts owns the schema). It's kept
// separate from layout.json — that file holds the split-panel/tab layout and
// has a different schema + a different writer, so sharing one file would let
// the two clobber each other.
func sidebarLayoutFilePath() (string, error) {
	return dataFilePath("sidebar-layout.json")
}

func dataFilePath(name string) (string, error) {
	if d := os.Getenv("XDG_DATA_HOME"); d != "" {
		return filepath.Join(d, "c3", name), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "share", "c3", name), nil
}

func handleLayout(originHost, originHostAlt string) http.HandlerFunc {
	return jsonFileHandler(layoutFilePath, originHost, originHostAlt)
}

func handleSidebarLayout(originHost, originHostAlt string) http.HandlerFunc {
	return jsonFileHandler(sidebarLayoutFilePath, originHost, originHostAlt)
}

// jsonFileHandler serves an opaque JSON sidecar file: GET returns the stored
// body (204 when absent/empty), PUT atomically replaces it (same-origin only,
// 64 KiB cap, must parse as a JSON object). The server never validates the
// schema — the client owns it — so a new field never needs a server change.
// Concurrent PUTs from multiple browser windows are last-writer-wins; the
// atomic temp+rename guarantees no torn read, but there is no merge.
func jsonFileHandler(pathFn func() (string, error), originHost, originHostAlt string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			handleLayoutGet(w, r, pathFn)
		case http.MethodPut:
			if !checkSameOrigin(w, r, originHost, originHostAlt) {
				return
			}
			handleLayoutPut(w, r, pathFn)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

func handleLayoutGet(w http.ResponseWriter, r *http.Request, pathFn func() (string, error)) {
	_ = r
	path, err := pathFn()
	if err != nil {
		httpError(w, err, http.StatusInternalServerError)
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		httpError(w, err, http.StatusInternalServerError)
		return
	}
	if len(b) == 0 {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(b)
}

func handleLayoutPut(w http.ResponseWriter, r *http.Request, pathFn func() (string, error)) {
	r.Body = http.MaxBytesReader(w, r.Body, int64(layoutMaxBytes))
	body, err := io.ReadAll(r.Body)
	if err != nil {
		// MaxBytesReader returns http.MaxBytesError-ish on overflow; the
		// concrete type isn't exported pre-Go 1.20 but the message includes
		// "request body too large". Translate to 413 either way.
		if strings.Contains(err.Error(), "too large") {
			http.Error(w, "layout payload exceeds 64 KiB", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "read body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if len(body) == 0 {
		http.Error(w, "empty body", http.StatusBadRequest)
		return
	}
	// Parse as opaque JSON object. We don't enforce the v1 schema — the
	// client owns that — but a malformed payload would corrupt the file
	// and break the next GET, so reject upfront.
	var probe map[string]any
	if err := json.Unmarshal(body, &probe); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	path, err := pathFn()
	if err != nil {
		httpError(w, err, http.StatusInternalServerError)
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		httpError(w, err, http.StatusInternalServerError)
		return
	}
	// Atomic write: tempfile in the same dir, then rename. rename(2) on
	// POSIX gives us "either the old file or the new file" — never a
	// truncated half-write — so concurrent GETs from another browser
	// window can't observe partial JSON.
	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+"-*.tmp")
	if err != nil {
		httpError(w, err, http.StatusInternalServerError)
		return
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(body); err != nil {
		tmp.Close()
		_ = os.Remove(tmpPath)
		httpError(w, err, http.StatusInternalServerError)
		return
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		httpError(w, err, http.StatusInternalServerError)
		return
	}
	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		httpError(w, err, http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Provider profiles (LLM backend switch + token storage)
// ---------------------------------------------------------------------------

// providerView is the per-profile JSON surfaced to the browser. The token is
// NEVER included — only hasToken — so secrets.json never leaves the server.
type providerView struct {
	ID       string            `json:"id"`
	Label    string            `json:"label"`
	BaseURL  string            `json:"baseUrl"`
	HasToken bool              `json:"hasToken"`
	Env      map[string]string `json:"env,omitempty"`
}

// handleProviders serves GET /api/providers — the active id plus the ordered
// profile list. Read-only; no CSRF guard needed.
func handleProviders(originHost, originHostAlt string) http.HandlerFunc {
	_ = originHost
	_ = originHostAlt
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		cfg, err := providers.Load()
		if err != nil {
			httpError(w, err, http.StatusInternalServerError)
			return
		}
		// Order: declared order first, then any profile not listed there.
		seen := map[string]bool{}
		var ids []string
		for _, id := range cfg.Order {
			if _, ok := cfg.Profiles[id]; ok && !seen[id] {
				ids = append(ids, id)
				seen[id] = true
			}
		}
		for id := range cfg.Profiles {
			if !seen[id] {
				ids = append(ids, id)
				seen[id] = true
			}
		}
		views := make([]providerView, 0, len(ids))
		for _, id := range ids {
			p := cfg.Profiles[id]
			has, _ := providers.HasToken(id)
			views = append(views, providerView{
				ID:       id,
				Label:    p.Label,
				BaseURL:  p.BaseURL,
				HasToken: has,
				Env:      p.Env,
			})
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, map[string]any{"active": cfg.Active, "profiles": views})
	}
}

// handleProvidersSub serves the mutating sub-routes (same-origin guarded):
//   - PUT /api/providers/active  {"id": "deepseek"}   ("" ⇒ passthrough)
//   - PUT /api/providers/token   {"id": "deepseek", "token": "sk-…"}
func handleProvidersSub(originHost, originHostAlt string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !checkSameOrigin(w, r, originHost, originHostAlt) {
			return
		}
		sub := strings.TrimPrefix(r.URL.Path, "/api/providers/")
		switch sub {
		case "active":
			var body struct {
				ID string `json:"id"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
				return
			}
			if err := providers.SetActive(body.ID); err != nil {
				httpError(w, err, http.StatusBadRequest)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		case "token":
			var body struct {
				ID    string `json:"id"`
				Token string `json:"token"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
				return
			}
			if err := providers.SetToken(body.ID, body.Token); err != nil {
				httpError(w, err, http.StatusBadRequest)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "not found", http.StatusNotFound)
		}
	}
}

// ---------------------------------------------------------------------------
// WS client adapter — implements ptymgr.Client over a coder/websocket conn.
// ---------------------------------------------------------------------------

type wsClient struct {
	conn    *websocket.Conn
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
		fmt.Fprintln(os.Stderr, "c3-server: write json:", err)
	}
}

func httpError(w http.ResponseWriter, err error, code int) {
	http.Error(w, err.Error(), code)
}

// shortUUID returns the first 8 chars of uuid for log lines, falling
// back to the full string if shorter. Guards against test injection of
// tiny uuids that would otherwise panic on [:8].
func shortUUID(u string) string {
	if len(u) >= 8 {
		return u[:8]
	}
	return u
}

// Ensure core import isn't dropped — needed for ToggleArchive's return type.
var _ = core.C3Entry{}

// ---------------------------------------------------------------------------
// Idle auto-shutdown
// ---------------------------------------------------------------------------

// idleCheckInterval is how often the watchdog polls manager state. Kept
// short relative to the timeout so the granularity error is small but
// long enough not to busy-loop.
const idleCheckInterval = 30 * time.Second

// idleTimeoutFromEnv reads C3_SERVER_IDLE_MINUTES. Default 15 minutes,
// 0 disables the watchdog.
func idleTimeoutFromEnv() time.Duration {
	v := os.Getenv("C3_SERVER_IDLE_MINUTES")
	if v == "" {
		return 15 * time.Minute
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n < 0 {
		fmt.Fprintf(os.Stderr, "c3-server: warn: invalid C3_SERVER_IDLE_MINUTES=%q, using default\n", v)
		return 15 * time.Minute
	}
	return time.Duration(n) * time.Minute
}

// defaultListenPort is the port used when C3_SERVER_PORT is unset.
// It is a string so the install build can override it via
//
//	go build -ldflags "-X main.defaultListenPort=7755" ./cmd/c3-server
//
// Source builds (plain `go build`, `go run`, `go install`) keep "0"
// → random OS-assigned port, which is the right default for dev
// (multiple concurrent checkouts, no bind-collision drama). Install
// builds (Makefile `install`, install.sh, future GoReleaser) set
// "7755" so the URL stays bookmarkable across launches.
//
// 7755 is in the IANA unassigned range so collisions with common
// dev-server defaults (3000, 5173, 8000, 8080) are unlikely.
var defaultListenPort = "0"

// portFromEnv reads C3_SERVER_PORT. Unset → defaultListenPort (which
// may itself be "0" for source builds or "7755" for installed
// builds). "0" → 0 (random). Any other valid uint16 → that port.
// Invalid → falls back to a hard-coded random (0) and warns.
func portFromEnv() int {
	v := os.Getenv("C3_SERVER_PORT")
	if v == "" {
		v = defaultListenPort
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n < 0 || n > 65535 {
		fmt.Fprintf(os.Stderr, "c3-server: warn: invalid port %q, using random (0)\n", v)
		return 0
	}
	return n
}

// portMode returns a short tag for the startup log so the user can
// tell at a glance whether this is an installed or source build.
func portMode() string {
	if defaultListenPort == "0" {
		return "dev"
	}
	return "installed"
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
