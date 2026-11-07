// Minimal DOM helpers and the shared form controls.
import { glyph } from './glyphs';

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
  search: glyph('search'),
  pan: glyph('tool-move'),
  rotate: glyph('rotate-ccw'),
  zoom: glyph('zoom-in'),
  maximize: glyph('maximize'),
  check: glyph('check'),
  close: glyph('close'),
  plus: glyph('plus'),
  minus: '<path d="M5 12h14"/>',
  info: '<path d="M12 11v7"/><circle cx="12" cy="6.5" r="1.4" fill="currentColor" stroke="none"/>',
  warning: glyph('warning'),
  dot: `<circle cx="12" cy="12" r="6" ${FILLED}/>`,
  play: glyph('play'),
  pause: glyph('pause'),
  first: glyph('skip-start'),
  last: glyph('skip-end'),
  prevKey: glyph('chevron-left'),
  nextKey: glyph('chevron-right'),
};

/** Icons for the side panel's sections, by title. */
const SECTION_ICONS: Record<string, Parameters<typeof glyph>[0]> = {
  Selection: 'cursor-select', Groups: 'layers', Shading: 'shading-solid', 'Game-ready meshes': 'tools', 'Face tool': 'fill-face',
  Mirror: 'modifier-mirror', Materials: 'material', Preview: 'shading-rendered', Looks: 'brush', Images: 'image', Surface: 'material',
  Finish: 'shading-textured', 'Texture maps': 'texture', 'Texture placement': 'uv', Gradient: 'paint', 'Test pose': 'pose',
  Skeleton: 'armature', Constraints: 'constraint', Skinning: 'vertex-group', 'Weight paint': 'paint', Display: 'display',
  Checks: 'check', Budget: 'settings', Joint: 'bone', 'Reference images': 'image', 'Start from': 'mesh-cube',
  'Draw body parts': 'tool-shape-draw', 'Draw any shape': 'tool-poly-draw', Detail: 'subdivide', 'Shape it': 'tool-scale',
  Colour: 'paint', Arrange: 'grid', Pieces: 'layers', Precision: 'snap', 'Vertex weights': 'vertex-group',
  'Vertex editing': 'vertex-select', 'Edge editing': 'edge-select', 'Face editing': 'face-select', 'Group editing': 'object-mode', 'Joint editing': 'bone',
};

// Folded sections stay folded between sessions.
const FOLD_KEY = 'thickshake.foldedSections';
const folded: Set<string> = (() => { try { return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) ?? '[]')); } catch { return new Set(); } })();

/** A side panel section: a header that folds it away, with an icon by its title, then its contents. */
export function section(title: string, ...kids: Child[]): HTMLElement {
  const icon = SECTION_ICONS[title];
  const el = h('section', { class: `panel-section${folded.has(title) ? ' folded' : ''}` });
  const head = h('button', {
    class: 'section-head', 'aria-expanded': String(!folded.has(title)), title: 'Fold or unfold',
    onclick: () => {
      const now = !folded.has(title);
      if (now) folded.add(title); else folded.delete(title);
      try { localStorage.setItem(FOLD_KEY, JSON.stringify([...folded])); } catch { /* storage may be off */ }
      el.classList.toggle('folded', now);
      head.setAttribute('aria-expanded', String(!now));
    },
  }, svgIcon('<path d="M9 6l6 6-6 6"/>', 12), icon ? h('span', { class: 'section-icon', html: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">${glyph(icon)}</svg>` }) : null, h('h3', null, title));
  el.append(head, h('div', { class: 'section-body' }, kids));
  return el;
}

/** Replace a host's content, keeping scroll position, unless the user is typing inside it. */
/** A field the user is typing in or dragging, which a redraw would take away from under them. Checkboxes, radios,
 *  buttons and drop-downs keep focus after a click but aren't mid-use, so they don't hold redraws back. */
function inUse(el: Element | null): boolean {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  const t = (el as HTMLInputElement).type;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'].includes(t);
}

export function renderInto(host: HTMLElement, build: () => Child, force = false) {
  if (scrubbing && !force) return;
  const active = document.activeElement;
  if (!force && active && host.contains(active) && inUse(active)) return;
  const top = host.scrollTop;
  host.replaceChildren();
  append(host, [build()]);
  host.scrollTop = top;
}
