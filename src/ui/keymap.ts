// Your own keyboard shortcuts: changes to the commands' keys, kept between sessions, and the editor for them.
import { comboOf, commands, rebuildShortcuts } from './commands';
import { button, h } from './dom';
import { modal, toast } from './feedback';

const KEY = 'thickshake.keymap';
/** Each command's own key, before any changes. */
const defaults = new Map<string, string | undefined>();

function load(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}; } catch { return {}; }
}
function save(map: Record<string, string>) {
  try { localStorage.setItem(KEY, JSON.stringify(map)); } catch { /* storage may be off */ }
}

/**
 * Put your shortcuts in place over the built-in ones. An empty string means no key. Call once the commands exist,
 * and again after a change.
 */
export function applyKeymap() {
  if (!defaults.size) commands.forEach((c) => defaults.set(c.id, c.key));
  const mine = load();
  commands.forEach((c) => {
    const k = c.id in mine ? mine[c.id] : defaults.get(c.id);
    if (k) c.key = k; else delete c.key;
  });
  rebuildShortcuts();
}

/** Give a command a key (or none), taking it from any command that had it. */
export function setShortcut(id: string, key: string) {
  const mine = load();
  if (key) commands.forEach((c) => { if (c.id !== id && c.key === key) mine[c.id] = ''; });
  mine[id] = key;
  // Back to its own key: no need to remember the change.
  if (defaults.get(id) === key || (!defaults.get(id) && !key)) delete mine[id];
  save(mine);
  applyKeymap();
}

export function resetShortcut(id: string) {
  const mine = load();
  delete mine[id];
  save(mine);
  applyKeymap();
}

export function resetAllShortcuts() { save({}); applyKeymap(); }

/** Keys a command can't take: plain modifiers, and keys the app reserves for typing in fields and closing things. */
const RESERVED = new Set(['Escape', 'Enter', 'Tab']);
const isModifier = (k: string) => ['Control', 'Shift', 'Alt', 'Meta'].includes(k);

/** The keymap editor: every command with its key, searchable, each one changeable by pressing the new key. */
export function openKeymapEditor() {
  const mine = load;
  const search = h('input', { class: 'field', placeholder: 'Find a command or key…', 'aria-label': 'Find a command' }) as HTMLInputElement;
  const list = h('div', { class: 'keymap-list' });
  let listening: { id: string; el: HTMLElement } | null = null;
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const changed = mine();
    const rows = [...commands.values()]
      .filter((c) => c.hint !== 'hidden' && c.label)
      .filter((c) => !q || c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q) || (c.key ?? '').toLowerCase().includes(q))
      .sort((a, b) => a.label.localeCompare(b.label));
    list.replaceChildren(...rows.map((c) => {
      const isMine = c.id in changed;
      const keyBtn = h('button', {
        class: `keymap-key${isMine ? ' changed' : ''}`, title: 'Click, then press the new key. Backspace clears it, Escape keeps it.',
        onclick: () => {
          listening?.el.classList.remove('listening');
          listening = { id: c.id, el: keyBtn };
          keyBtn.classList.add('listening');
          keyBtn.textContent = 'Press a key…';
        },
      }, c.key ?? '—');
      return h('div', { class: 'keymap-row' },
        h('span', { class: 'keymap-label' }, c.label, h('span', { class: 'muted small' }, ` ${c.id}`)),
        keyBtn,
        isMine ? button('Reset', () => { resetShortcut(c.id); draw(); }, { class: 'btn btn-small', title: `Back to ${defaults.get(c.id) ?? 'no key'}` }) : h('span', { class: 'keymap-spacer' }),
      );
    }));
  };
  // Catch the next key for the command waiting for one, ahead of the dialog's own keys.
  const onKey = (e: KeyboardEvent) => {
    if (!listening || isModifier(e.key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const { id } = listening;
    listening = null;
    if (e.key === 'Escape') { draw(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') { setShortcut(id, ''); draw(); return; }
    if (RESERVED.has(e.key)) { toast(`${e.key} is kept for typing and dialogs. Try another key.`, 'info'); draw(); return; }
    const combo = comboOf(e);
    const other = [...commands.values()].find((c) => c.key === combo && c.id !== id);
    setShortcut(id, combo);
    if (other) toast(`${combo} was ${other.label}'s; now it's ${commands.get(id)!.label}'s, and ${other.label} has no key.`, 'info', 5000);
    draw();
  };
  window.addEventListener('keydown', onKey, true);
  search.addEventListener('input', draw);
  draw();
  void modal('Keyboard shortcuts', h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, 'Click a key to change it. Tool keys inside the view (G, R and S while moving, and the paint and tile keys) stay as they are.'),
    search, list,
  ), [
    { label: 'Reset all', danger: true, run: () => { resetAllShortcuts(); draw(); toast('Every shortcut is back to its own key.', 'ok'); return false; } },
    { label: 'Done', primary: true },
  ], { width: 620 }).then(() => window.removeEventListener('keydown', onKey, true));
  search.focus();
}
