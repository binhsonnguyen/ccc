// Package webdev embeds the minimal Phase 2 HTML client into the
// c3-server binary so it stays self-contained. Phase 3 will replace
// these assets with a Vite-built React bundle.
package webdev

import (
	"embed"
	"io/fs"
)

//go:embed all:assets
var assets embed.FS

// FS returns the embedded web/dev directory rooted at "assets/".
func FS() fs.FS {
	sub, err := fs.Sub(assets, "assets")
	if err != nil {
		panic(err)
	}
	return sub
}
