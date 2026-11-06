// Minimal DOM helpers and the shared form controls.

type Child = Node | string | number | null | undefined | false | Child[];

export function h(tag: string, props: Record<string, any> | null = null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled') (el as any)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: HTMLElement, kids: Child[]) {
  for (const c of kids) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** True during a label drag; panels must not rebuild the element being dragged. */
let scrubbing = false;

/** Numeric input with drag-to-scrub on its label. */
export function numField(opts: {
  label?: string; value: number; step?: number; min?: number; max?: number; digits?: number; title?: string; axis?: 0 | 1 | 2;
  onInput?: (v: number) => void; onChange?: (v: number) => void; onScrubStart?: () => void; onScrubEnd?: () => void;
}): HTMLElement {
  const digits = opts.digits ?? 3;
  const step = opts.step ?? 0.01;
  const clamp = (v: number) => Math.max(opts.min ?? -Infinity, Math.min(opts.max ?? Infinity, v));
  const fmt = (v: number) => String(+v.toFixed(digits));
  const input = h('input', { type: 'text', inputmode: 'decimal', class: 'num-input', value: fmt(opts.value), title: opts.title }) as HTMLInputElement;
  const commit = () => {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) { input.value = fmt(opts.value); return; }
    const c = clamp(v);
    opts.value = c;
    input.value = fmt(c);
    opts.onChange?.(c);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { commit(); input.blur(); }
    if (e.key === 'Escape') { input.value = fmt(opts.value); input.blur(); }
  });
  input.addEventListener('focus', () => input.select());
  const label = opts.label
    ? h('span', { class: `num-label${opts.axis !== undefined ? ` axis-${opts.axis}` : ''}`, title: 'Drag to change' }, opts.label)
    : null;
  label?.addEventListener('pointerdown', (e: PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX, v0 = opts.value;
    scrubbing = true;
    opts.onScrubStart?.();
    const mv = (ev: PointerEvent) => {
      const mult = ev.shiftKey ? 0.1 : ev.ctrlKey ? 10 : 1;
      const v = clamp(v0 + (ev.clientX - x0) * step * mult);
      opts.value = v;
      input.value = fmt(v);
      (opts.onInput ?? opts.onChange)?.(v);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      mv(ev); // The last move can be coalesced into the release.
      scrubbing = false;
      // onScrubEnd owns the commit when present; calling onChange too would apply it twice.
      if (opts.onScrubEnd) opts.onScrubEnd();
      else if (opts.onInput && opts.onChange) opts.onChange(opts.value);
    };
    // Track on the window so the drag survives leaving the label.
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  // A div, not a <label>: clicking a label would focus the input, and panels don't redraw while typing.
  if (opts.label) input.setAttribute('aria-label', opts.label);
  return h('div', { class: 'num-field' }, label, input);
}

export function checkbox(label: string, value: boolean, onChange: (v: boolean) => void, title?: string): HTMLElement {
  return h('label', { class: 'check', title },
    h('input', { type: 'checkbox', checked: value, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) }),
    h('span', null, label));
}

export function select<T extends string | number>(value: T, options: [T, string][], onChange: (v: T) => void, title?: string): HTMLSelectElement {
  return h('select', {
    class: 'field-select', title,
    onchange: (e: Event) => {
      const raw = (e.target as HTMLSelectElement).value;
      onChange((typeof value === 'number' ? +raw : raw) as T);
    },
  }, options.map(([v, l]) => h('option', { value: String(v), selected: v === value }, l))) as HTMLSelectElement;
}

export function button(label: Child, onClick: (e: MouseEvent) => void, opts: { class?: string; title?: string; disabled?: boolean } = {}): HTMLElement {
  return h('button', { class: opts.class ?? 'btn', title: opts.title, disabled: opts.disabled, onclick: onClick }, label);
}

export function svgIcon(path: string, size = 18): HTMLElement {
  return h('span', {
    class: 'icon',
    html: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`,
  });
}

const FILLED = 'fill="currentColor" stroke="none"';

/** Shared interface icons, drawn on a 24 x 24 grid. */
export const ICONS = {
  pan: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 3v5h-5"/>',
  zoom: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>',
  maximize: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  info: '<path d="M12 11v7"/><circle cx="12" cy="6.5" r="1.4" fill="currentColor" stroke="none"/>',
  warning: '<path d="M12 5v9"/><circle cx="12" cy="18.5" r="1.4" fill="currentColor" stroke="none"/>',
  dot: `<circle cx="12" cy="12" r="6" ${FILLED}/>`,
  play: `<path d="M7 4.5v15l12-7.5z" ${FILLED}/>`,
  pause: `<rect x="6" y="4.5" width="4.5" height="15" rx="1" ${FILLED}/><rect x="13.5" y="4.5" width="4.5" height="15" rx="1" ${FILLED}/>`,
  first: `<rect x="4.5" y="5" width="3" height="14" rx="1" ${FILLED}/><path d="M20 5v14L9 12z" ${FILLED}/>`,
  last: `<rect x="16.5" y="5" width="3" height="14" rx="1" ${FILLED}/><path d="M4 5v14l11-7z" ${FILLED}/>`,
  prevKey: `<path d="M11 5v14L2.5 12z" ${FILLED}/><path d="M17 6.5l5 5.5-5 5.5-5-5.5z" ${FILLED}/>`,
  nextKey: `<path d="M13 5v14l8.5-7z" ${FILLED}/><path d="M7 6.5l5 5.5-5 5.5-5-5.5z" ${FILLED}/>`,
};

export function section(title: string, ...kids: Child[]): HTMLElement {
  return h('section', { class: 'panel-section' }, h('h3', null, title), kids);
}

/** Replace a host's content, keeping scroll position, unless the user is typing inside it. */
export function renderInto(host: HTMLElement, build: () => Child) {
  if (scrubbing) return;
  const active = document.activeElement;
  if (active && host.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA')) return;
  const top = host.scrollTop;
  host.replaceChildren();
  append(host, [build()]);
  host.scrollTop = top;
}
