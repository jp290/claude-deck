import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

const $ = (id: string) => document.getElementById(id)!;
const app = $("app"), ta = $("input") as HTMLTextAreaElement, dot = $("dot"),
  jump = $("jump"), keys = $("keys"), send = $("send") as HTMLButtonElement;

const term = new Terminal({
  scrollback: 50000,
  fontSize: 13,
  disableStdin: true,
  fontFamily: "ui-monospace, Menlo, Consolas, monospace",
  theme: { background: "#141414", foreground: "#d8d8d8" },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open($("term"));
// read-only view: never pop the iOS keyboard when tapping/scrolling the terminal
term.textarea!.readOnly = true;
term.textarea!.setAttribute("inputmode", "none");
(window as any).term = term;

function post(path: string, body: unknown) {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// --- layout: iOS keyboard shrinks visualViewport but not the layout viewport ---
function vfit() {
  const vv = window.visualViewport;
  app.style.height = (vv?.height ?? window.innerHeight) + "px";
  app.style.transform = `translateY(${vv?.offsetTop ?? 0}px)`;
  window.scrollTo(0, 0);
}
let lastCols = 0, lastRows = 0;
function sendResize() {
  fit.fit();
  if (term.cols === lastCols && term.rows === lastRows) return;
  lastCols = term.cols;
  lastRows = term.rows;
  post("/resize", { cols: term.cols, rows: term.rows });
}
let resizeTimer: ReturnType<typeof setTimeout>;
function onViewportChange() {
  vfit();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(sendResize, 500);
}
window.addEventListener("resize", onViewportChange);
window.visualViewport?.addEventListener("resize", onViewportChange);
vfit();
fit.fit();

// --- websocket stream ---
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    dot.className = "on";
    sendResize();
  };
  ws.onmessage = (e) => term.write(new Uint8Array(e.data as ArrayBuffer));
  ws.onclose = () => {
    dot.className = "off";
    setTimeout(connect, 1500);
  };
}
connect();

// --- jump-to-bottom pill ---
function updateJump() {
  const b = term.buffer.active;
  jump.style.display = b.viewportY < b.baseY - 1 ? "flex" : "none";
}
term.onScroll(updateJump);
term.onWriteParsed(updateJump);
document.querySelector(".xterm-viewport")!.addEventListener("scroll", updateJump, { passive: true });
jump.onclick = () => term.scrollToBottom();

// keys row is for navigating TUI dialogs — reclaim its space while composing
ta.addEventListener("focus", () => { keys.style.display = "none"; });
ta.addEventListener("blur", () => { keys.style.display = "flex"; });

// --- command prefix chips ---
const CMDS = ["/sharpen", "/gosharp", "/sharpen3", "/gosharp3"];
function currentPrefix(): string | null {
  for (const c of CMDS) if (ta.value === c || ta.value.startsWith(c + " ")) return c;
  return null;
}
function updateChips() {
  const active = currentPrefix();
  for (const el of document.querySelectorAll<HTMLButtonElement>("#chips .chip"))
    el.classList.toggle("active", el.dataset.cmd === active);
}
function togglePrefix(cmd: string) {
  const active = currentPrefix();
  const rest = active ? ta.value.slice(active.length).replace(/^ /, "") : ta.value;
  ta.value = active === cmd ? rest : cmd + " " + rest;
  updateChips();
}
ta.addEventListener("input", updateChips);

// --- toolbar ---
for (const el of document.querySelectorAll<HTMLButtonElement>("#bar [data-key]"))
  el.onclick = () => post("/key", { key: el.dataset.key });
for (const el of document.querySelectorAll<HTMLButtonElement>("#bar [data-cmd]"))
  el.onclick = () => togglePrefix(el.dataset.cmd!);

// voice = iOS keyboard dictation: focus the input so the keyboard (with its mic key) opens
$("mic").onclick = () => ta.focus();

send.onclick = async () => {
  const text = ta.value.trim();
  if (!text || send.disabled) return;
  send.disabled = true;
  try {
    await post("/send", { text, submit: true });
    ta.value = "";
    updateChips();
    term.scrollToBottom();
  } finally {
    send.disabled = false;
  }
};
