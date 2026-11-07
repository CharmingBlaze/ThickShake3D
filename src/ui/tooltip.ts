// Tooltips for every control: the name, its shortcut as keys, and what it does, in a styled card instead of the
// browser's plain one. Any element with a title gets one; the title moves aside so the browser doesn't show its own.
import { h } from './dom';

const DELAY = 380;
/** After one tooltip closes, the next shows at once for a moment, so moving along a toolbar reads smoothly. */
const WARM = 600;

let tip: HTMLElement | null = null;
let timer = 0;
let current: HTMLElement | null = null;
let lastHide = 0;

/** A shortcut at the end of a name, as "Move (W)" or "Bevel (Ctrl+B)". */
const KEY_AT_END = /\s\(((?:Ctrl|Shift|Alt|Cmd|F\d{1,2}|Space|Delete|Backspace|Enter|Home|End|Tab|Esc|Page ?Up|Page ?Down|Numpad|[A-Z0-9]|[[\].,=+\-<>])[^()]{0,24})\)$/;

function parse(text: string): { name: string | null; keys: string[]; body: string } {
  const lines = text.split('\n');
  const first = lines[0];
  const m = first.match(KEY_AT_END);
  if (m) return { name: first.slice(0, m.index).trim(), keys: m[1].split(/\s*\/\s*|\s+or\s+/), body: lines.slice(1).join('\n').trim() };
  // Several lines: the first is the name. One line: it's all description.
  if (lines.length > 1) return { name: first, keys: [], body: lines.slice(1).join('\n').trim() };
  return { name: null, keys: [], body: text };
}

/** Keys drawn as keycaps: "Ctrl+Shift+D" becomes three. */
function keycaps(combo: string): HTMLElement {
  const parts = combo === '+' ? ['+'] : combo.split('+').filter(Boolean);
  return h('span', { class: 'tip-keys' }, parts.map((p, i) => [i ? h('span', { class: 'tip-plus' }, '+') : null, h('kbd', { class: 'tip-key' }, p)]));
}

function show(el: HTMLElement) {
  const text = el.dataset.tip;
  if (!text) return;
  const { name, keys, body } = parse(text);
  tip?.remove();
  tip = h('div', { class: 'tip', role: 'tooltip' },
    name || keys.length ? h('div', { class: 'tip-head' }, name ? h('span', { class: 'tip-name' }, name) : null, keys.length ? h('span', { class: 'tip-combos' }, keys.map((k, i) => [i ? h('span', { class: 'tip-or' }, 'or') : null, keycaps(k)])) : null) : null,
    body ? h('div', { class: 'tip-body' }, body) : null);
  document.body.appendChild(tip);
  // Below the control, or above it near the bottom; kept inside the window.
  const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
  let x = r.left + r.width / 2 - t.width / 2;
  let y = r.bottom + 6;
  if (y + t.height > window.innerHeight - 4) y = r.top - t.height - 6;
  // Beside a control on the left edge (the tool rail), so the card doesn't cover its neighbours.
  if (r.left < 60 && r.width < 60) { x = r.right + 8; y = r.top + r.height / 2 - t.height / 2; }
  x = Math.max(4, Math.min(window.innerWidth - t.width - 4, x));
  y = Math.max(4, Math.min(window.innerHeight - t.height - 4, y));
  tip.style.left = `${Math.round(x)}px`;
  tip.style.top = `${Math.round(y)}px`;
  requestAnimationFrame(() => tip?.classList.add('show'));
}

function hide() {
  clearTimeout(timer);
  if (tip) { tip.remove(); tip = null; lastHide = performance.now(); }
  current = null;
}

/** Take over every title in the page. Call once. */
export function installTooltips() {
  document.addEventListener('mouseover', (e) => {
    const el = (e.target as HTMLElement | null)?.closest?.('[title], [data-tip]') as HTMLElement | null;
    if (!el || el === current) return;
    // Move the title aside, so the browser's own tooltip stays away; a later title replaces it.
    const title = el.getAttribute('title');
    if (title) { el.dataset.tip = title; el.removeAttribute('title'); }
    if (!el.dataset.tip) return;
    hide();
    current = el;
    const warm = performance.now() - lastHide < WARM;
    timer = window.setTimeout(() => { if (current === el && el.isConnected) show(el); }, warm ? 40 : DELAY);
  });
  document.addEventListener('mouseout', (e) => {
    if (!current) return;
    const to = e.relatedTarget as Node | null;
    if (to && current.contains(to)) return;
    hide();
  });
  for (const ev of ['mousedown', 'wheel', 'keydown', 'blur', 'scroll']) window.addEventListener(ev, () => { if (current || tip) hide(); }, true);
}
