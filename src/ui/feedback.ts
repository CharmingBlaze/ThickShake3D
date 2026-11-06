// Toasts, the status line, and modal dialogs.
import { h } from './dom';

let toastHost: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;

export function setStatusEl(el: HTMLElement) { statusEl = el; }
export function status(text: string) { if (statusEl) statusEl.textContent = text; }

export function toast(text: string, kind: 'info' | 'warn' | 'error' | 'ok' = 'info', ms = 3600) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const t = h('div', { class: `toast toast-${kind}` }, text);
  toastHost.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 220); }, ms);
}

export interface ModalButton { label: string; primary?: boolean; danger?: boolean; value?: any; run?: () => void | boolean | Promise<void | boolean> }

export function modal(title: string, body: Node | string, buttons: ModalButton[], opts: { width?: number } = {}): Promise<any> {
  return new Promise((resolve) => {
    const close = (v: any) => {
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') close(undefined);
      const tag = (e.target as HTMLElement).tagName;
      if (e.key === 'Enter' && tag !== 'BUTTON' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        (card.querySelector('.btn-primary') as HTMLElement | null)?.click();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const card = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: opts.width ? { width: `${opts.width}px` } : undefined },
      h('header', null, title),
      h('div', { class: 'modal-body' }, body),
      h('footer', null, buttons.map((b) => h('button', {
        class: `btn${b.primary ? ' btn-primary' : ''}${b.danger ? ' btn-danger' : ''}`,
        onclick: async () => {
          if (b.run) {
            const keepOpen = await b.run();
            if (keepOpen === false) return;
          }
          close(b.value ?? b.label);
        },
      }, b.label))));
    const back = h('div', { class: 'modal-back', onpointerdown: (e: Event) => { if (e.target === back) close(undefined); } }, card);
    document.body.appendChild(back);
    (card.querySelector('.btn-primary') as HTMLElement | null)?.focus();
  });
}

export function reportError(context: string, e: unknown) {
  console.error(context, e);
  toast(`${context}: ${e instanceof Error ? e.message : String(e)}`, 'error', 6000);
}
