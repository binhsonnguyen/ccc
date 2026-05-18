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

# Override only at install time; source builds keep "0" (random).
INSTALL_LDFLAGS := -X main.defaultListenPort=7755

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
	go build -ldflags '$(INSTALL_LDFLAGS)' -o $(PREFIX)/bin/c3-server ./cmd/c3-server
	go build                                -o $(PREFIX)/bin/c3-bin    ./cmd/c3-bin
	@echo "installed → $(PREFIX)/bin/{c3-bin,c3-server} (port 7755)"

clean:
	rm -rf web/node_modules web/dist bin
