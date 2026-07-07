# Claude Deck

Mobile remote control for a Claude Code session — native scrollback on iPhone, voice via iOS dictation, /sharpen & /gosharp prefix buttons.

**URL:** http://127.0.0.1:8788 (Tailnet only)

## Architecture — tmux without attach

The tmux scrollback problem only exists when you `attach`. Here tmux is just the persistent pty holder:

- `tmux -L claudedeck` session `deck` runs `claude; exec zsh` (headless, never attached)
- `pipe-pane` streams the program's **raw output** to `stream.raw`; the Bun server tails it and broadcasts over WebSocket
- xterm.js (client) keeps its own 50k-line scrollback → native iOS momentum scroll, no copy-mode, ever
- Input goes through `tmux load-buffer` + `paste-buffer -p` (bracketed paste) + `send-keys` — never through an attach
- Reconnect/reload replays the last 2 MB of the stream → full history restored
- Server restart is safe: pipe + stream file persist; a fresh session gets seeded via `capture-pane -e -S -` + resize-jiggle repaint

## Ops

```sh
tmux -L claudedeck new-session -d -s srv 'cd ~/claude-deck && exec bun server.ts >> server.log 2>&1'  # start server
tmux -L claudedeck kill-session -t srv                                                                # stop server
tmux -L claudedeck kill-session -t deck && rm stream.raw                                              # fresh claude session
bun run build                                                                                         # rebuild client after editing src/client.ts
```

Env: `DECK_HOST` (default 127.0.0.1), `DECK_PORT` (8788), `DECK_CWD` (claude working dir, default ~).

## Pinned: xterm 5.5.0, NOT 6.x

xterm 6 removed the `.xterm-scroll-area` DOM element — the viewport div no longer has real scrollable height, so native touch scrolling silently breaks. 5.5.0 (+ addon-fit 0.10.0) uses the classic overflow-scroll viewport. Do not upgrade without re-testing touch scroll on device.

## Known limits

- `stream.raw` grows unbounded (~KB/interaction; delete it together with the deck session when starting fresh)
- One shared terminal size — last connected client wins
- iOS keyboard open shrinks the viewport → tmux resize → TUI reflow churn (cosmetic)
