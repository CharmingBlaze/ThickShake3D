// A toolbar button that opens a dropdown of commands.
import { commands, runCommand } from './commands';
import { h, ICONS, svgIcon } from './dom';

const CHEVRON = '<path d="M6 9l6 6 6-6"/>';
let open: { menu: HTMLElement; button: HTMLElement } | null = null;

function closeMenu() {
  if (!open) return;
  open.menu.remove();
  open.button.classList.remove('open');
  open.button.setAttribute('aria-expanded', 'false');
  open = null;
}

export interface FlyoutItem { command: string; label: string; icon: string }

/** A tool rail button that opens a list of tools beside it, each with its icon and name. */
export function flyoutButton(label: string, icon: string, items: (FlyoutItem | null)[]): HTMLElement {
  const b = h('button', { class: 'tool-btn tool-flyout', title: label, 'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, svgIcon(icon));
  const toggle = (focus: boolean) => {
    const wasOpen = open?.button === b;
    closeMenu();
    if (wasOpen) return;
    const r = b.getBoundingClientRect();
    // Past the edge of the rail, not just the button.
    const right = (b.parentElement ?? b).getBoundingClientRect().right;
    b.classList.add('open');
    b.setAttribute('aria-expanded', 'true');
    const menu = h('div', { class: 'menu flyout-menu', role: 'menu', 'aria-label': label, style: { left: `${right + 2}px`, top: `${r.top}px` } }, items.map((item) => {
      if (!item) return h('div', { class: 'menu-sep' });
      return h('button', {
        class: `menu-item flyout-item${commands.get(item.command)?.checked?.() ? ' active' : ''}`, role: 'menuitem',
        onclick: () => { closeMenu(); runCommand(item.command); },
      }, svgIcon(item.icon, 16), h('span', { class: 'menu-label' }, item.label));
    }));
    const moveFocus = (step: number) => {
      const list = [...menu.querySelectorAll<HTMLElement>('.menu-item')];
      const at = list.indexOf(document.activeElement as HTMLElement);
      list[(at + step + list.length) % list.length].focus();
    };
    menu.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      e.stopPropagation();
      moveFocus(e.key === 'ArrowDown' ? 1 : -1);
    });
    document.body.appendChild(menu);
    open = { menu, button: b };
    const m = menu.getBoundingClientRect();
    if (m.bottom > window.innerHeight - 4) menu.style.top = `${Math.max(4, window.innerHeight - m.height - 4)}px`;
    if (focus) (menu.querySelector<HTMLElement>('.active') ?? menu.querySelector<HTMLElement>('.menu-item'))?.focus();
  };
  b.addEventListener('pointerdown', (e: PointerEvent) => { e.stopPropagation(); toggle(false); });
  // A click with no pointer behind it is the keyboard: Enter or Space on the focused button.
  b.addEventListener('click', (e: MouseEvent) => { if (e.detail === 0) toggle(true); });
  return b;
}

window.addEventListener('pointerdown', (e) => { if (open && !open.menu.contains(e.target as Node)) closeMenu(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); closeMenu(); } }, true);

/**
 * A button that opens a dropdown of commands. `opts.class` replaces the button's look; `opts.itemLabel` names the
 * items instead of the commands' own labels, and `opts.title` is its tooltip.
 */
export function menuButton(label: string, ids: (string | null)[], opts: { class?: string; itemLabel?: (id: string) => string; title?: string } = {}): HTMLElement {
  const b = h('button', { class: opts.class ?? 'btn btn-small uv-menu-btn', 'aria-haspopup': 'menu', title: opts.title }, h('span', { class: 'menu-btn-label' }, label), svgIcon(CHEVRON, 12));
  b.addEventListener('pointerdown', (e: PointerEvent) => {
    e.stopPropagation();
    const wasOpen = open?.button === b;
    closeMenu();
    if (wasOpen) return;
    const r = b.getBoundingClientRect();
    b.classList.add('open');
    const menu = h('div', { class: 'menu', role: 'menu', style: { left: `${r.left}px`, top: `${r.bottom + 2}px` } }, ids.map((id) => {
      if (id === null) return h('div', { class: 'menu-sep' });
      const c = commands.get(id);
      if (!c) return null;
      return h('button', {
        class: 'menu-item', role: 'menuitem', disabled: c.enabled ? !c.enabled() : false, title: c.hint && c.hint !== 'hidden' ? c.hint : undefined,
        onclick: () => { closeMenu(); runCommand(id); },
      }, h('span', { class: 'menu-check' }, c.checked?.() ? svgIcon(ICONS.check, 14) : null), h('span', { class: 'menu-label' }, opts.itemLabel?.(id) ?? c.label), c.key ? h('kbd', null, c.key) : null);
    }));
    document.body.appendChild(menu);
    open = { menu, button: b };
    const m = menu.getBoundingClientRect();
    if (m.right > window.innerWidth - 4) menu.style.left = `${Math.max(4, window.innerWidth - m.width - 4)}px`;
    // Near the bottom of the window, as the timeline is, a menu opens upward.
    if (m.bottom > window.innerHeight - 4) menu.style.top = `${Math.max(4, r.top - m.height - 2)}px`;
  });
  return b;
}
