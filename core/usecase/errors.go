package usecase

import "errors"

// Sentinel errors that callers (CLI + server) map to UX surfaces:
//   - HTTP: 400 (validation), 404 (not found), 409 (conflict).
//   - CLI:  stderr message + non-zero exit.
//
// Use errors.Is to check; underlying *fmt.wrapError wraps these so detail
// can be added per call-site without breaking the contract.
var (
	ErrNotFound     = errors.New("session not found")
	ErrPTYLive      = errors.New("session has a live PTY")
	ErrAlreadyBound = errors.New("claude uuid already bound")
	ErrValidation   = errors.New("validation failed")
)
