// Ctrl+K command palette with fuzzy matching.
import { commands, runCommand } from './commands';
import { h } from './dom';

function score(q: string, text: string): number {
  const t = text.toLowerCase();
  if (!q) return 1;
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct;
  let i = 0, s = 0, last = -1;
  for (const c of q) {
    const at = t.indexOf(c, i);
    if (at < 0) return -1;
    s += at === last + 1 ? 5 : 1;
    last = at; i = at + 1;
  }
  return s;
}

export function openPalette() {
  if (document.querySelector('.palette-back')) return;
  const input = h('input', { class: 'palette-input', placeholder: 'Type a command…', 'aria-label': 'Search commands', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const list = h('div', { class: 'palette-list', role: 'listbox' });
  let items: { id: string; label: string; key?: string }[] = [];
  let cur = 0;
  const close = () => back.remove();
  const go = (id: string) => { close(); runCommand(id); };
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    items = [...commands.values()]
      .filter((c) => c.hint !== 'hidden' && (!c.enabled || c.enabled()))
      .map((c) => ({ c, s: score(q, c.label) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s || a.c.label.localeCompare(b.c.label))
      .slice(0, 40)
      .map((x) => ({ id: x.c.id, label: x.c.label, key: x.c.key }));
    cur = Math.min(cur, Math.max(0, items.length - 1));
    list.replaceChildren(...(items.length
      ? items.map((it, i) => h('div', {
        class: `palette-item${i === cur ? ' active' : ''}`, role: 'option',
        onpointerdown: (e: Event) => { e.preventDefault(); go(it.id); },
      }, h('span', null, it.label), it.key ? h('kbd', null, it.key) : null))
      : [h('div', { class: 'palette-empty' }, 'No matching commands')]));
    (list.children[cur] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => { cur = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown') { e.preventDefault(); cur = Math.min(items.length - 1, cur + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cur = Math.max(0, cur - 1); draw(); }
    else if (e.key === 'Enter' && items[cur]) go(items[cur].id);
  });
  const back = h('div', { class: 'palette-back', onpointerdown: (e: Event) => { if (e.target === back) close(); } },
    h('div', { class: 'palette' }, input, list));
  document.body.appendChild(back);
  draw();
  input.focus();
}
