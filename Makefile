# ccc — top-level build targets.
#
# Two build flavors:
#   - dev (default): random OS-assigned port. Right for source checkouts —
#     multiple concurrent clones don't fight over a single port.
#   - installed: fixed port 7755 via -ldflags. Right for users running the
#     installed binary; the URL stays bookmarkable across launches.
#
# `make web` builds the Vite bundle into internal/webdev/assets/ so the
# next `go build` embeds the new client. Run `make build` for both.

PREFIX ?= $(HOME)/.local

# Version stamp for installed builds. "make install VERSION=v0.1.0"
# overrides; default falls back to `git describe` so a local install
# off main shows the commit it was built from.
VERSION ?= $(shell git describe --tags --dirty --always 2>/dev/null || echo dev)

# Override only at install time; source builds keep "0" (random) and
# version "dev".
SERVER_LDFLAGS := -X main.defaultListenPort=7755 -X main.version=$(VERSION)
BIN_LDFLAGS    := -X main.version=$(VERSION)

.PHONY: web web-install build server install clean

web-install:
	cd web && npm install

web:
	cd web && npm install && npm run build

# Dev build: defaultListenPort stays "0" → random port at runtime.
server:
	go build -o bin/c3-server ./cmd/c3-server

build: web server

# Install build: bakes 7755 into c3-server via ldflag (c3-bin reads the
# port from the discovery file, doesn't carry its own default). Drops
# both binaries in $(PREFIX)/bin. Re-run after editing web/ to refresh
# the embedded bundle.
install: web
	mkdir -p $(PREFIX)/bin
	go build -ldflags '$(SERVER_LDFLAGS)' -o $(PREFIX)/bin/c3-server ./cmd/c3-server
	go build -ldflags '$(BIN_LDFLAGS)'    -o $(PREFIX)/bin/c3-bin    ./cmd/c3-bin
	@echo "installed → $(PREFIX)/bin/{c3-bin,c3-server} (port 7755, version $(VERSION))"

clean:
	rm -rf web/node_modules web/dist bin
