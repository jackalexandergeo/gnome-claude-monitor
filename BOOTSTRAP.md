# Bootstrap: the top bar and the kanban board

**For an AI assistant (Claude Code or similar) setting up two things on one person's Linux
GNOME desktop.** Read this whole file first, then do the steps in order. Where a step says
**Ask**, ask the user and wait.

1. **This extension**: Claude Code usage in the GNOME top bar (sessions, 5-hour and weekly
   limits), plus an optional Issues button. The Issues button lists the issues a local hub
   such as pingwatch is tracking, pops up when one needs the user, and answers its review
   gates.
2. **[driftboard](https://github.com/jackalexandergeo/driftboard)**, a kanban board served
   from this machine. pingwatch keeps one card per issue on it, in a column per status.

Both run entirely on this machine and read only the user's own local files. Nothing here
signs in to or sends anything to another service.

## Rules for you while you set this up

- **Do not reload GNOME Shell or log the user out without asking.** On Wayland the only way
  to load a new extension is to log out, which closes every window.
- Do not change other extensions or GNOME settings beyond this extension's own.
- Do not publish, push or commit anything. This is an install, not a change to either repo.

## 1. Check what is needed

| Needed | Check |
|---|---|
| GNOME Shell 48 | `gnome-shell --version` |
| Which session | `echo $XDG_SESSION_TYPE` (x11 or wayland; it decides step 3) |
| Claude Code, signed in | `claude --version`, and `~/.claude` exists |
| git | `git --version` |
| node 18 or newer (for the board only) | `node --version` |

Without node, skip steps 5 to 7: the extension works without the board.

## 2. Install the extension

The fork's work is on the `pingwatch-issues` branch (`main` follows the original).

    git clone -b pingwatch-issues https://github.com/jackalexandergeo/gnome-claude-monitor.git ~/gnome-claude-monitor
    cd ~/gnome-claude-monitor && ./install.sh

`install.sh` copies the extension to `~/.local/share/gnome-shell/extensions/claude-usage@aidan.local`,
compiles its settings schema and enables it. To update it later, `git pull` and run
`./install.sh` again.

## 3. Load it

**Ask** before doing either:

- **X11**: the user presses Alt+F2, types `r` and presses Enter. That reloads the shell in
  place, and the windows stay open.
- **Wayland**: the user logs out and back in.

Then check:

    gnome-extensions info claude-usage@aidan.local     # State: ACTIVE

The top bar shows something like `🤖 1/3 │ ⏱ 13% · 4h13m`: running and total sessions, then
the 5-hour usage and its reset countdown.

## 4. Place it

**Ask** where they want it. They can pick it in the extension's settings
(`gnome-extensions prefs claude-usage@aidan.local`, "Top-bar placement"), or you can set it:

    gsettings --schemadir ~/.local/share/gnome-shell/extensions/claude-usage@aidan.local/schemas \
      set org.gnome.shell.extensions.claude-usage panel-box left-middle    # left, center, right or left-middle
    gsettings --schemadir ~/.local/share/gnome-shell/extensions/claude-usage@aidan.local/schemas \
      set org.gnome.shell.extensions.claude-usage panel-position 1         # 0 = first in that section

The change applies at once, without a reload. `left-middle` is "Middle of the left half",
between the Activities button and the clock.

## 5. Install the board

    git clone https://github.com/jackalexandergeo/driftboard.git ~/driftboard
    cd ~/driftboard && npm install

Use `~/driftboard`: that is where pingwatch looks for it.

## 6. Run the board

**With pingwatch installed**, let it run the board. Run its install script again: it now
finds `~/driftboard` and adds `driftboard.service` (data in `~/.local/share/driftboard`) and
`pingwatch-board.service` (the sync). Then enable both:

    ~/pingwatch/bin/install-services
    systemctl --user enable --now driftboard.service pingwatch-board.service
    pingwatch board --open                # opens the board, on the pingwatch workspace

**Without pingwatch**, run the board on its own and open it signed in:

    cd ~/driftboard && npm start          # serves http://127.0.0.1:4321
    npm run open                          # in another terminal: opens the browser, signed in

**Ask** about sign-in. By default the board takes a token: `npm run open` signs the browser
in once, and it stays signed in. pingwatch's unit starts it with `DRIFTBOARD_SIGN_IN=off`
(no sign-in), which suits a machine nobody else logs into. But then every process of every
account on it can read the board and press its card buttons, which start and close issues.
If anyone else can log into this machine, remove that line from
`~/.config/systemd/user/driftboard.service`, set `signIn = true` under `[board]` in
pingwatch's config, and restart both services.

## 7. Connect the Issues button

The Issues button appears by itself once a hub writes its snapshot to
`~/.local/state/pingwatch/state.json` (the format is in this repo's README). With
pingwatch's hub running there is nothing to set up. Within a minute the top bar shows
`💬 <open issues>`: orange while issues are open, red with `!` when one needs the user.

To see it work without waiting for a real ping, send one through pingwatch's API. Then
close it again:

    pingwatch ping --source bootstrap-test --thread bootstrap-test-1 --issue \
      --title "Test issue from the bootstrap" --body "Test ping: please ignore."
    pingwatch issues                      # note its id
    pingwatch close <id> --reason "bootstrap test"

A notification pops up for the new issue, its card appears in the board's New column, and
the close moves it to Won't do.

## When something is off

| Symptom | Look at |
|---|---|
| nothing in the top bar after the reload | `gnome-extensions info claude-usage@aidan.local`; `journalctl --user -b -g claude-usage` |
| `⚠ Pull failed` in the dropdown | Claude Code is signed out: the user runs `claude` and signs in |
| no Issues button | `ls -l ~/.local/state/pingwatch/state.json`: no hub is writing it |
| Issues shows `–` | the hub has not written for three minutes: `systemctl --user status pingwatch-hub` |
| the board asks for a token | open it with `npm run open` or `pingwatch board --open`, not by typing the address |
| board at the wrong address | `PORT` and `DRIFTBOARD_DATA` must match between the server and `npm run open` |
