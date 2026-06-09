# Release & Homebrew tap

c3 is released with GoReleaser (`.goreleaser.yml`) to GitHub Releases +
the Homebrew tap `binhsonnguyen/homebrew-tap`. Distribution is a
**Homebrew Cask** (GoReleaser deprecated binary-install formulas in
v2.16; casks are the supported path for pre-compiled binaries).

## Cutting a release

```sh
# from a clean main, with the new tag pushed:
GITHUB_TOKEN=$(gh auth token) GORELEASER_CURRENT_TAG=vX.Y.Z \
  goreleaser release --clean
```

The `before` hooks run `go mod tidy` + `make web` so the embedded web
assets match. GoReleaser builds 4 targets, publishes the release, and
pushes `Casks/c3.rb` to the tap.

Before tagging:

```sh
make web && git diff --exit-code   # ensure embedded assets are committed;
                                   # the release hook re-runs make web and a
                                   # dirty tree at tag time is a footgun
go build ./... && go test ./...
./bin/c3-bin --version && ./bin/c3-server --version   # smoke (no cask `test`)
goreleaser check                                       # must be clean
goreleaser release --snapshot --clean --skip=publish   # inspect dist/homebrew/Casks/c3.rb
```

There is no CI gate — the cask has no `test` stanza, so the `--version`
smoke test above is the manual replacement. Run it every release.

## Platform note: brew is macOS-only

A Homebrew **cask cannot be installed on Linux** (`brew` errors with
"Casks are not supported on Linux"). So `brew install
binhsonnguyen/tap/c3` works on **macOS only**. The release still builds
Linux binaries — Linux users install via the release tarball or
`make install`, and `c3 service` manages a systemd `--user` unit for
them. Keep the README/caveats honest about this; do not imply brew works
on Linux.

## One-time: formula → cask migration in the tap repo

The tap previously held `Formula/c3.rb`. After the first cask release,
do this **once** in the **`binhsonnguyen/homebrew-tap`** repo (it is a
separate repository, not this one):

1. Confirm GoReleaser pushed `Casks/c3.rb`.
2. Delete the old `Formula/c3.rb`.
3. Add `tap_migrations.json` at the repo root:

   ```json
   {
     "c3": "binhsonnguyen/tap/c3"
   }
   ```

   Key = old formula token, value = the cask's fully-qualified token in
   the same tap. On `brew update`, anyone who installed the old formula
   auto-migrates to the cask. This same-tap formula→cask migration
   requires **Homebrew ≥ 5.0.0** (Nov 2025); today's users are well past
   that.
4. Commit both changes.

`brew install binhsonnguyen/tap/c3` keeps working for new users (brew
resolves the cask once the formula is gone — no `--cask` needed).

## What changed vs the old formula (and why)

Casks can't express two things the old `brews` formula did; both moved
into the app, which makes them work identically for brew, `make
install`, and raw-tarball users:

| Old formula feature | Now |
| --- | --- |
| `install` block placing `c3.sh` / `c3.fish` into the prefix | `c3-bin shell-init <bash\|zsh\|fish>` emits the wrapper; users `eval` it in their rc (see README). |
| `service do` block → `brew services start c3` | `c3 service {start\|stop\|status}` writes a LaunchAgent (macOS) / systemd `--user` unit (Linux) with `C3_SERVER_IDLE_MINUTES=0`. |
| `test` block | Dropped (casks have none); smoke-test with `c3-bin --version` in CI/manually. |

Cask-only gains: a `postflight` `xattr -dr com.apple.quarantine` hook so
the unsigned binaries don't trip Gatekeeper, and `zap` cleanup of c3's
own data dirs + the LaunchAgent on `brew uninstall --zap`.

## Migration note for existing service users

The old formula's `brew services start c3` registered a LaunchAgent
labelled `homebrew.mxcl.c3`; the new app-managed service uses
`com.c3.server`. After the formula→cask migration, `brew services`
no longer knows about c3, so the old job can linger. Users who ran the
old service should, after upgrading:

```sh
# stop the OLD formula service (best-effort; may already be gone)
brew services stop c3 2>/dev/null
launchctl bootout gui/$(id -u)/homebrew.mxcl.c3 2>/dev/null
rm -f "$(brew --prefix)/opt/c3/homebrew.mxcl.c3.plist" 2>/dev/null

# start the new app-managed service
c3 service start
```

Until the old job is stopped, both servers can race for port 7755.
