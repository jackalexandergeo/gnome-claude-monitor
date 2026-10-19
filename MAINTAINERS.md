# Maintainer guide

Building, testing, and releasing **Claude Usage**. Users don't need any of this —
see the [README](README.md) to install and use it.

## Repo layout

```
claude-usage@aidan.local/   the extension
  metadata.json             uuid, shell-version, version, settings-schema
  extension.js              enable()/disable(), panel placement
  dataService.js            file I/O, usage API (libsoup), refresh engine
  blocks.js                 pure 5h-window math (unit-tested)
  pings.js                  pure logic for the optional Issues button (unit-tested)
  pingService.js            watches the Issues snapshot file, opens links/sessions
  pingIndicator.js          the Issues panel button + dropdown
  indicator.js              panel button + dropdown UI
  prefs.js                  preferences (libadwaita)
  stylesheet.css            colours
  schemas/                  GSettings schema
  icons/                    robot + speedometer SVGs
build.sh                    build the release zip
install.sh                  install from source (local dev)
online-install.sh           one-liner installer (downloads latest release)
test/blocks-test.js         `gjs -m test/blocks-test.js`
test/pings-test.js          `gjs -m test/pings-test.js`
test/ping-service-test.js   `gjs -m test/ping-service-test.js`
```

## Local dev loop

Edit the source, then reinstall and reload the shell:

```sh
./install.sh                              # copies into place, compiles schema, enables
# X11: Alt+F2 -> r -> Enter   |   Wayland: log out/in
```

Watch for runtime errors while testing:

```sh
journalctl -f -o cat /usr/bin/gnome-shell | grep -i claude-usage
```

## Tests

Pure logic (5h-window math, token sums) is unit-tested with plain gjs — no shell needed:

```sh
gjs -m test/blocks-test.js
gjs -m test/pings-test.js
gjs -m test/ping-service-test.js
```

## Build a zip locally

Needs `libglib2.0-bin` (for `glib-compile-schemas`) + `zip`. You rarely need this by
hand — CI runs the same script on a tag push (see below):

```sh
./build.sh          # -> dist/claude-usage.shell-extension.zip
```

## Cut a release

Releases are automated: pushing a `v*` tag triggers
[`.github/workflows/release.yml`](.github/workflows/release.yml), which runs `build.sh`
and attaches the zip to a GitHub Release. Because the one-liner installer always points at
`releases/latest/download/…`, publishing a release is all it takes for users to get the
update.

**Two version numbers, and they move together:**

- `metadata.json` → `"version"` is an **integer** GNOME uses to detect an update. Bump it
  every release (`1` → `2` → `3` …).
- The **git tag** (`vX.Y.Z`) names the release. Keep it in lockstep: `v1.0.0` ↔ version `1`,
  `v1.1.0` ↔ version `2`, and so on.

Steps:

```sh
# 1. bump metadata.json "version", then commit the release-worthy changes
git add -A && git commit -m "feat: <what changed>"

# 2. pre-flight: same checks CI will run
for test in test/*-test.js; do gjs -m "$test" || break; done && ./build.sh

# 3. push, then tag + push the tag to trigger the release build
git push origin main
git tag v1.1.0
git push origin v1.1.0
```

Watch the build on the repo's **Actions** tab; when it finishes, verify by re-running the
one-liner from the README (it pulls the newest release).
