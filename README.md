# Claude Deck

Mobile remote control for a Claude Code session — native scrollback on iPhone, voice via iOS dictation, /sharpen & /gosharp prefix buttons, and a live-input mode for typing straight into the pane (slash-menus, TUI dialogs).

**Quickstart:**
```sh
bun install
bun run build
DECK_HOST=$(tailscale ip -4) bun server.ts   # or your LAN IP; defaults to 127.0.0.1 (loopback only)
```
Then open `http://<that-ip>:8788` from your phone (same Tailscale network / LAN).

⚠️ This spawns `claude --dangerously-skip-permissions` and exposes it with **no authentication** beyond whatever network you bind it to — see Known Limits before setting `DECK_HOST` to anything broader than a private Tailscale/LAN address.

## Architecture — tmux without attach

The tmux scrollback problem only exists when you `attach`. Here tmux is just the persistent pty holder:

- `tmux -L claudedeck` session `deck` runs `claude --dangerously-skip-permissions; exec zsh` (headless, never attached)
- `pipe-pane` streams the program's **raw output** to `stream.raw`; the Bun server tails it and broadcasts over WebSocket
- xterm.js (client) keeps its own 50k-line scrollback → native iOS momentum scroll, no copy-mode, ever
- Compose-box input goes through `tmux load-buffer` + `paste-buffer -p` (bracketed paste) + `send-keys` — never through an attach
- Live-input mode (⌨) relays raw keystrokes byte-for-byte via the WebSocket → `send-keys -H` (hex), serialized through a promise queue so fast typing can't reorder. Large pastes are chunked client-side to stay under the server's 1024-byte-per-message cap; both send paths (compose box and live paste) surface failure visibly instead of silently discarding what you typed
- Reconnect/reload replays the last 2 MB of the stream → full history restored
- Server restart is safe: pipe + stream file persist; a fresh session gets seeded via `capture-pane -e -S -` + resize-jiggle repaint
- Self-healing: a 2s health check recreates the `deck` session if it ever dies (crash, accidental `kill-session`) and broadcasts a clear-scrollback sequence to already-connected clients so they don't show duplicated pre/post-recreate history

## Ops

```sh
tmux -L claudedeck new-session -d -s srv 'cd ~/claude-deck && exec bun server.ts >> server.log 2>&1'  # start server
tmux -L claudedeck kill-session -t srv                                                                # stop server
tmux -L claudedeck kill-session -t deck && rm stream.raw                                              # fresh claude session (self-heals within 2s, srv stays up)
bun run build                                                                                         # rebuild client after editing src/client.ts
```

Env: `DECK_HOST` (default `127.0.0.1` — loopback only, set to your Tailscale/LAN IP to reach it from another device), `DECK_PORT` (8788), `DECK_CWD` (claude working dir, default `$HOME`).

The four command chips (`/sharpen`, `/gosharp`, …) are this author's own custom Claude Code skills — edit `CMDS` in `src/client.ts` and the matching buttons in `public/index.html` to swap in your own, or remove them.

## Pinned: xterm 5.5.0, NOT 6.x

xterm 6 removed the `.xterm-scroll-area` DOM element — the viewport div no longer has real scrollable height, so native touch scrolling silently breaks. 5.5.0 (+ addon-fit 0.10.0) uses the classic overflow-scroll viewport. Do not upgrade without re-testing touch scroll on device.

## Known limits

- `stream.raw` grows unbounded (~KB/interaction; delete it together with the deck session when starting fresh)
- One shared terminal size — last connected client wins
- iOS keyboard open shrinks the viewport → tmux resize → TUI reflow churn (cosmetic)
- No auth beyond the Tailnet itself — anyone on the tailnet can reach a `--dangerously-skip-permissions` shell at this URL; consistent with this device's SSH-key-only/Tailnet-is-the-boundary model, but worth remembering since this session can now execute anything unattended
- Live-input's `send-keys -H` writes into the target pty's normal input stream — a plain shell/`cat`-like program without its own raw-mode line editing can hit the kernel tty's canonical-mode line-length limit (~1024 bytes of *unterminated* input) regardless of client-side chunking. Not an issue against Claude Code's own input box (it manages its own raw-mode buffering), verified with a 2500-byte paste landing byte-for-byte intact — but worth knowing if you ever repoint this at a bare shell
