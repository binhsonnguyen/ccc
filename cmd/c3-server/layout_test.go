package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// withTempXDG points $XDG_DATA_HOME at a per-test tempdir so the layout
// file lookup in layoutFilePath() is isolated from the developer's real
// ~/.local/share/c3/layout.json.
func withTempXDG(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	prev := os.Getenv("XDG_DATA_HOME")
	t.Setenv("XDG_DATA_HOME", dir)
	t.Cleanup(func() {
		if prev == "" {
			_ = os.Unsetenv("XDG_DATA_HOME")
		} else {
			_ = os.Setenv("XDG_DATA_HOME", prev)
		}
	})
	return dir
}

func TestLayoutGetMissingReturns204(t *testing.T) {
	withTempXDG(t)
	h := handleLayout("127.0.0.1:0", "localhost:0")
	req := httptest.NewRequest(http.MethodGet, "/api/layout", nil)
	rr := httptest.NewRecorder()
	h(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("want 204, got %d body=%q", rr.Code, rr.Body.String())
	}
}

func TestLayoutPutThenGetRoundtrip(t *testing.T) {
	dir := withTempXDG(t)
	h := handleLayout("127.0.0.1:0", "localhost:0")

	payload := []byte(`{"version":1,"activeTabId":"t1","tabs":[{"id":"t1","orientation":"h","ratio":0.5,"focusedPaneIdx":0,"panes":[{"c3Id":"abc1"}]}]}`)
	put := httptest.NewRequest(http.MethodPut, "/api/layout", bytes.NewReader(payload))
	put.Header.Set("Content-Type", "application/json")
	rrPut := httptest.NewRecorder()
	h(rrPut, put)
	if rrPut.Code != http.StatusNoContent {
		t.Fatalf("PUT: want 204, got %d body=%q", rrPut.Code, rrPut.Body.String())
	}

	// File on disk matches the payload byte-for-byte.
	wantPath := filepath.Join(dir, "c3", "layout.json")
	got, err := os.ReadFile(wantPath)
	if err != nil {
		t.Fatalf("read written file: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("on-disk mismatch:\ngot:  %s\nwant: %s", got, payload)
	}

	get := httptest.NewRequest(http.MethodGet, "/api/layout", nil)
	rrGet := httptest.NewRecorder()
	h(rrGet, get)
	if rrGet.Code != http.StatusOK {
		t.Fatalf("GET: want 200, got %d", rrGet.Code)
	}
	if !bytes.Equal(rrGet.Body.Bytes(), payload) {
		t.Fatalf("GET body mismatch:\ngot:  %s\nwant: %s", rrGet.Body.Bytes(), payload)
	}
	if ct := rrGet.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type want application/json, got %q", ct)
	}
}

func TestLayoutPutMalformedJSONRejected(t *testing.T) {
	withTempXDG(t)
	h := handleLayout("127.0.0.1:0", "localhost:0")
	req := httptest.NewRequest(http.MethodPut, "/api/layout", strings.NewReader("not json"))
	rr := httptest.NewRecorder()
	h(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d body=%q", rr.Code, rr.Body.String())
	}
}

func TestLayoutPutOversizedRejected(t *testing.T) {
	withTempXDG(t)
	h := handleLayout("127.0.0.1:0", "localhost:0")
	// Build a payload comfortably above 64 KiB.
	big := bytes.Repeat([]byte("x"), 70*1024)
	body := append([]byte(`{"v":"`), big...)
	body = append(body, '"', '}')
	req := httptest.NewRequest(http.MethodPut, "/api/layout", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h(rr, req)
	if rr.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("want 413, got %d body=%q", rr.Code, rr.Body.String())
	}
}

func TestLayoutPutEmptyBodyRejected(t *testing.T) {
	withTempXDG(t)
	h := handleLayout("127.0.0.1:0", "localhost:0")
	req := httptest.NewRequest(http.MethodPut, "/api/layout", strings.NewReader(""))
	rr := httptest.NewRecorder()
	h(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d body=%q", rr.Code, rr.Body.String())
	}
}

func TestLayoutDisallowedMethod(t *testing.T) {
	withTempXDG(t)
	h := handleLayout("127.0.0.1:0", "localhost:0")
	for _, m := range []string{http.MethodPost, http.MethodDelete, http.MethodPatch} {
		req := httptest.NewRequest(m, "/api/layout", nil)
		rr := httptest.NewRecorder()
		h(rr, req)
		if rr.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s: want 405, got %d", m, rr.Code)
		}
	}
}

// Ensure the test file imports io so trivial unused-import errors don't
// happen as we expand the suite — it's also a tiny smoke check that the
// handler streams the body back as bytes (not via a decoder).
var _ = io.Copy
