# ccc — top-level build targets.
#
# `make web` builds the Vite bundle into internal/webdev/assets/ so the
# next `go build` embeds the new client. Run `make build` for both.

.PHONY: web web-install build server clean

web-install:
	cd web && npm install

web:
	cd web && npm install && npm run build

server:
	go build -o bin/c3-server ./cmd/c3-server

build: web server

clean:
	rm -rf web/node_modules web/dist bin
