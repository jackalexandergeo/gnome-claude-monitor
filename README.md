<h1 align="center">Claude Usage — GNOME Shell extension</h1>

<p align="center">
  <a href="https://github.com/AMitchell-GitHub/gnome-claude-monitor/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/AMitchell-GitHub/gnome-claude-monitor?logo=github&color=e76125"></a>
  <a href="https://github.com/AMitchell-GitHub/gnome-claude-monitor/releases"><img alt="Total downloads" src="https://img.shields.io/github/downloads/AMitchell-GitHub/gnome-claude-monitor/total?logo=github&label=downloads&color=e76125"></a>
  <img alt="GNOME Shell 48" src="https://img.shields.io/badge/GNOME_Shell-48-4A86CF?logo=gnome&logoColor=white">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/github/license/AMitchell-GitHub/gnome-claude-monitor?color=blue"></a>
</p>

<p align="center">
  A top-bar indicator that shows your live <b>Claude Code</b> sessions and your <b>usage</b>
  against Claude's rolling limits — at a glance, with a dropdown for the details.
</p>

<p align="center">
  <img width="392" alt="Panel indicator: sessions running and 5-hour usage" src="https://github.com/user-attachments/assets/49a81f29-fa9e-4e32-9546-c875df7e232b">
  <br><br>
  <img width="506" alt="Dropdown: per-session tokens, 5h and weekly usage, plan tier" src="https://github.com/user-attachments/assets/f53791f5-7f1d-4b1f-9e8b-60f7faf67cc5">
</p>

## Install

Paste this into a terminal — it downloads the latest release and installs it:

```sh
curl -fsSL https://raw.githubusercontent.com/AMitchell-GitHub/gnome-claude-monitor/main/online-install.sh | bash
```

Then **load it** by reloading GNOME Shell:

- **X11:** press `Alt`+`F2`, type `r`, press `Enter` (your windows stay open)
- **Wayland:** log out and back in

That's it — look for the 🤖 in your top bar. Not sure which one you're on? Run
`echo $XDG_SESSION_TYPE`.

<details>
<summary><b>Other ways to install</b> (release zip, or from source)</summary>

**From a release zip**

1. Grab `claude-usage.shell-extension.zip` from the [latest release](https://github.com/AMitchell-GitHub/gnome-claude-monitor/releases/latest).
2. `gnome-extensions install --force claude-usage.shell-extension.zip`
3. Reload the shell (see above), then `gnome-extensions enable claude-usage@aidan.local`.

**From source**

```sh
git clone https://github.com/AMitchell-GitHub/gnome-claude-monitor.git
cd gnome-claude-monitor
./install.sh        # copies into place + compiles the schema + enables
```

</details>

## What you need

- **GNOME Shell 48** (X11 or Wayland)
- **[Claude Code](https://claude.com/claude-code)** installed and signed in — the extension reads its local files

## What it shows

The top bar stays compact: `🤖 1/3 │ ⏱ 13% · 4h13m` — running/total sessions (the count
turns orange when one is working), then your 5-hour usage and reset countdown.

Click it for the full picture:

- **Sessions** — one row per live session: its name (or project folder), busy/idle dot, uptime, and
  **that session's token usage** (per-agent tokens over the last ~26h; hidden once a
  session has been idle longer than that)
- **Usage** — 5h window (% bar + reset countdown), weekly window (% + reset + any
  model-specific Opus/Sonnet limits), your plan tier, and today's tokens
- **Status line** — e.g. `Updated 12s ago · source: api`, or in red `⚠ Pull failed: HTTP 429`
- **Refresh now** — force an immediate update

### Optional: an Issues button for agent pipelines

If a local tool writes an issue snapshot to `$XDG_STATE_HOME/pingwatch/state.json`
(default `~/.local/state/pingwatch/state.json`), a second button appears next to the
usage one: `💬 3`, orange while issues are open and red with `!` when one needs you.
Its dropdown lists each issue as `[project]: title · status`, with links to the source
thread, the ticket, any merge requests, and **Agent: <role>** entries that open
`claude attach <id>` in a terminal. When the snapshot says an issue asks something
(`question`) or a review waits on you (`awaiting: ["ticket" | "change"]`), the issue shows
the question and **Approve / Reject** items, which POST
`{"gate": ..., "approve": true | false}` to `/v1/issues/<id>/decisions` over the Unix socket
named in `hub.socket`. New issues and "needs you" changes raise a desktop
notification; clicking it opens the thread. Changes made while the screen was locked are
announced after unlock (what was announced is kept in
`$XDG_STATE_HOME/claude-usage/pings-announced.json`), and more than four at once fold into
one summary. Without that file the button never shows.

The snapshot format (version 1):

```json
{"version": 1, "updatedAt": 1760000000000, "hub": {"socket": "/run/user/1000/pingwatch/hub.sock"},
 "counts": {"today": 1, "total": 4, "open": 1, "untriaged": 0},
 "issues": [{"id": 7, "name": "[demo]: Build server disk full", "status": "new", "kind": "issue",
             "source": "chat", "url": "https://…", "updatedAt": 1760000000000,
             "links": {"ticket": {"url": "https://…", "reference": "#12"},
                       "mergeRequests": [{"url": "https://…", "reference": "!34"}],
                       "sessions": [{"role": "research", "sessionId": "a1b2c3d4"}]},
             "question": null, "awaiting": [],
             "lastPing": {"author": "alex", "preview": "can you check the disk?", "createdAt": 1760000000000}}],
 "otherPings": []}
```

The writer should refresh `updatedAt` at least once a minute; after three minutes without
an update the button shows `–` (or a red `–!` if an issue was last seen needing you) and the
dropdown says the hub is not responding.

**Settings:** pick where it sits in the top bar (left / center / right, plus position) —
changes apply live. Open them any time with `gnome-extensions prefs claude-usage@aidan.local`.

## Your data stays on your machine

| Shown | Where it comes from |
|-------|---------------------|
| Sessions + busy/idle status | `~/.claude/sessions/*.json` (filtered to live PIDs via `/proc`) — local |
| 5h + weekly usage % and reset | `GET https://api.anthropic.com/api/oauth/usage` — the same endpoint Claude Code's `/usage` and claude.ai/settings/usage use |
| Plan tier | `~/.claude.json` (`oauthAccount`) — local |
| Today's tokens + per-session tokens | `~/.claude/projects/*/*.jsonl` — local (transcript entries joined to sessions by `sessionId`) |
| Issues (optional) | `~/.local/state/pingwatch/state.json` — local, written by your own tool |

The usage call reuses your existing local OAuth token from `~/.claude/.credentials.json` as a
Bearer token to read **your own** usage. The token is read locally and sent only to
`api.anthropic.com` — never stored, logged, or sent anywhere else. The API is polled about
once a minute; the countdown ticks locally in between. If the API is unreachable, the
extension falls back to a local estimate from your transcripts (marked `*`/`~`) and the
dropdown status line shows the error.

## Troubleshooting

- **Don't see it after installing?** You must reload the shell (see [Install](#install)).
  Then check it's on: `gnome-extensions info claude-usage@aidan.local`.
- **Usage shows `n/a` or a `⚠` error?** Make sure Claude Code is signed in. A red
  `HTTP 429` just means the API is rate-limiting — it recovers on its own.
- **Watch for errors while it runs:** `journalctl -f -o cat /usr/bin/gnome-shell | grep -i claude-usage`

## Contributing / maintainers

Building a zip, cutting a release, running the tests, and the repo layout live in
**[MAINTAINERS.md](MAINTAINERS.md)**.

## License

[MIT](LICENSE)
