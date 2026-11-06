// A colour picker: saturation square, hue bar, hex box, eyedropper, recent colours, palettes and matching colours.
import { harmonies, hexToHsv, hexToRgb, hsvToHex, parseHex, PALETTES, type Palette } from '../core/materials';
import { h, ICONS, svgIcon } from './dom';

const RECENT_KEY = 'thickshake.recentColors', PALETTE_KEY = 'thickshake.palettes', ACTIVE_KEY = 'thickshake.activePalette';

// A viewer's browser may refuse storage. That only loses the memory of these, so everything still works.
const load = <T>(key: string, fallback: T): T => {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; }
};
const save = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* best effort */ } };

export const colorStore = {
  recent: load<string[]>(RECENT_KEY, []),
  custom: load<Palette[]>(PALETTE_KEY, []),
  active: load<string>(ACTIVE_KEY, PALETTES[0].name),
  all(): Palette[] { return [...this.custom, ...PALETTES]; },
  current(): Palette { return this.all().find((p) => p.name === this.active) ?? PALETTES[0]; },
  isCustom(name: string) { return this.custom.some((p) => p.name === name); },
  setActive(name: string) { this.active = name; save(ACTIVE_KEY, name); },
  remember(hex: string) {
    this.recent = [hex, ...this.recent.filter((c) => c !== hex)].slice(0, 12);
    save(RECENT_KEY, this.recent);
  },
  /** Add a palette under a free name, and make it the active one. */
  addPalette(name: string, colors: string[]) {
    let unique = name, n = 2;
    while (this.all().some((p) => p.name === unique)) unique = `${name} ${n++}`;
    this.custom = [{ name: unique, colors }, ...this.custom];
    save(PALETTE_KEY, this.custom);
    this.setActive(unique);
    return unique;
  },
  addColor(hex: string) {
    const p = this.custom.find((x) => x.name === this.active);
    if (!p) { this.addPalette('My colours', [hex]); return; }
    if (!p.colors.includes(hex)) p.colors = [...p.colors, hex];
    save(PALETTE_KEY, this.custom);
  },
  removeColor(hex: string) {
    const p = this.custom.find((x) => x.name === this.active);
    if (!p) return;
    p.colors = p.colors.filter((c) => c !== hex);
    save(PALETTE_KEY, this.custom);
  },
  deletePalette(name: string) {
    this.custom = this.custom.filter((p) => p.name !== name);
    save(PALETTE_KEY, this.custom);
    if (this.active === name) this.setActive(PALETTES[0].name);
  },
};

export interface ColorCallbacks {
  /** Called as the colour changes, for a live preview. */
  onInput(hex: string): void;
  /** Called when the picker closes with a new colour kept. */
  onCommit(hex: string): void;
  /** Called when the picker is dismissed with Esc, to undo the live preview. */
  onCancel(): void;
}

let open: { el: HTMLElement; finish: (keep: boolean) => void } | null = null;

export function closeColorPicker(keep = true) { open?.finish(keep); }

export function colorPickerOpen() { return open !== null; }

declare global { interface Window { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } } }

/** Open the picker beside an element. */
export function openColorPicker(anchor: HTMLElement, start: string, cb: ColorCallbacks) {
  closeColorPicker();
  let [hue, sat, val] = hexToHsv(start);
  let current = start;
  let changed = false;

  const sv = h('canvas', { class: 'cp-sv', width: '220', height: '120' }) as HTMLCanvasElement;
  const hueBar = h('canvas', { class: 'cp-hue', width: '220', height: '12' }) as HTMLCanvasElement;
  const svDot = h('div', { class: 'cp-dot' });
  const hueDot = h('div', { class: 'cp-hue-dot' });
  const before = h('button', { class: 'cp-swatch cp-before', title: 'Back to the colour you started with', style: { background: start }, onclick: () => setHex(start) });
  const now = h('div', { class: 'cp-swatch', style: { background: start } });
  const hexIn = h('input', { class: 'cp-hex', value: start, spellcheck: 'false', 'aria-label': 'Hex colour' }) as HTMLInputElement;
  const rgbText = h('span', { class: 'muted small cp-rgb' });
  const lists = h('div', { class: 'cp-lists' });

  const drawSv = () => {
    const g = sv.getContext('2d')!;
    g.fillStyle = hsvToHex(hue, 1, 1); g.fillRect(0, 0, sv.width, sv.height);
    const w = g.createLinearGradient(0, 0, sv.width, 0);
    w.addColorStop(0, '#fff'); w.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = w; g.fillRect(0, 0, sv.width, sv.height);
    const b = g.createLinearGradient(0, 0, 0, sv.height);
    b.addColorStop(0, 'rgba(0,0,0,0)'); b.addColorStop(1, '#000');
    g.fillStyle = b; g.fillRect(0, 0, sv.width, sv.height);
  };
  const drawHue = () => {
    const g = hueBar.getContext('2d')!;
    const l = g.createLinearGradient(0, 0, hueBar.width, 0);
    for (let i = 0; i <= 6; i++) l.addColorStop(i / 6, hsvToHex(i * 60, 1, 1));
    g.fillStyle = l; g.fillRect(0, 0, hueBar.width, hueBar.height);
  };

  const swatch = (hex: string, title?: string) => h('button', { class: `cp-chip${hex === current ? ' active' : ''}`, style: { background: hex }, title: title ?? hex, 'aria-label': title ?? hex, onclick: () => setHex(hex) });
  const row = (title: string, colors: string[]) => (colors.length ? h('div', { class: 'cp-row' }, h('div', { class: 'cp-title' }, title), h('div', { class: 'cp-chips' }, colors.map((c) => swatch(c)))) : null);

  const renderLists = () => {
    const p = colorStore.current();
    const { shades, matches } = harmonies(current);
    lists.replaceChildren(...[
      row('Recent', colorStore.recent),
      h('div', { class: 'cp-row' },
        h('div', { class: 'cp-title cp-title-row' },
          h('select', {
            class: 'cp-palette', 'aria-label': 'Palette',
            onchange: (e: Event) => { colorStore.setActive((e.target as HTMLSelectElement).value); renderLists(); },
          }, colorStore.all().map((x) => h('option', { value: x.name, selected: x.name === p.name }, x.name))),
          h('button', {
            class: 'cp-mini', title: colorStore.isCustom(p.name) ? `Add this colour to ${p.name}` : 'Save this colour to a palette of your own',
            'aria-label': 'Add colour to palette',
            onclick: () => { colorStore.addColor(current); renderLists(); },
          }, svgIcon(ICONS.plus, 12)),
        ),
        h('div', { class: 'cp-chips' }, p.colors.map((c) => swatch(c))),
      ),
      row('Shades', shades),
      row('Goes with', matches),
    ].filter(Boolean) as HTMLElement[]);
  };

  const sync = (fromHex: boolean) => {
    current = fromHex ? current : hsvToHex(hue, sat, val);
    svDot.style.left = `${sat * 100}%`;
    svDot.style.top = `${(1 - val) * 100}%`;
    svDot.style.background = current;
    hueDot.style.left = `${(hue / 360) * 100}%`;
    now.style.background = current;
    if (document.activeElement !== hexIn) hexIn.value = current;
    const [r, g, b] = hexToRgb(current);
    rgbText.textContent = `${r}, ${g}, ${b}`;
  };

  const push = () => {
    changed = current !== start;
    cb.onInput(current);
  };

  function setHex(hex: string) {
    current = hex;
    const [a, b, c] = hexToHsv(hex);
    // Black and grey have no hue of their own, so the hue bar stays where it was.
    if (b > 0.001) hue = a;
    sat = b; val = c;
    drawSv(); sync(true); push(); renderLists();
  }

  const dragOn = (el: HTMLElement, fn: (x: number, y: number) => void) => {
    el.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const move = (ev: PointerEvent) => fn(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)));
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); renderLists(); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      move(e);
    });
  };
  const svWrap = h('div', { class: 'cp-sv-wrap' }, sv, svDot);
  dragOn(svWrap, (x, y) => { sat = x; val = 1 - y; sync(false); push(); });
  const hueWrap = h('div', { class: 'cp-hue-wrap' }, hueBar, hueDot);
  dragOn(hueWrap, (x) => { hue = x * 359.9; drawSv(); sync(false); push(); });

  hexIn.addEventListener('input', () => { const hx = parseHex(hexIn.value); if (hx) { const keep = hexIn.value; setHex(hx); hexIn.value = keep; } });
  hexIn.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });

  const dropper = window.EyeDropper ? h('button', {
    class: 'cp-mini cp-dropper', title: 'Pick a colour from anywhere on screen', 'aria-label': 'Pick a colour from the screen',
    onclick: async () => {
      try { setHex((await new window.EyeDropper!().open()).sRGBHex); } catch { /* Cancelled with Esc. */ }
    },
  }, svgIcon('<path d="M14 4l6 6-3 3-1-1-7 7H6v-3l7-7-1-1z"/>', 15)) : null;

  const el = h('div', { class: 'color-picker', role: 'dialog', 'aria-label': 'Choose a colour' },
    svWrap, hueWrap,
    h('div', { class: 'cp-values' }, before, now, hexIn, dropper),
    rgbText,
    lists,
  );
  drawHue(); drawSv(); sync(true); renderLists();
  document.body.appendChild(el);

  // Beside the control, but always fully on screen.
  const a = anchor.getBoundingClientRect();
  const m = el.getBoundingClientRect();
  const left = a.left - m.width - 8 > 4 ? a.left - m.width - 8 : Math.min(window.innerWidth - m.width - 4, a.right + 8);
  el.style.left = `${Math.max(4, left)}px`;
  el.style.top = `${Math.max(4, Math.min(window.innerHeight - m.height - 4, a.top - 20))}px`;

  const outside = (e: PointerEvent) => { if (!el.contains(e.target as Node)) finish(true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); finish(false); } };
  setTimeout(() => window.addEventListener('pointerdown', outside, true));
  window.addEventListener('keydown', onKey, true);

  function finish(keep: boolean) {
    if (open?.el !== el) return;
    open = null;
    window.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('keydown', onKey, true);
    el.remove();
    if (keep && changed) { colorStore.remember(current); cb.onCommit(current); }
    else cb.onCancel();
  }
  open = { el, finish };
  return el;
}

/** A button showing a colour, which opens the picker. */
export function colorButton(value: string, title: string, cb: ColorCallbacks): HTMLElement {
  return h('button', {
    class: 'color-btn', style: { background: value }, title: `${title}: ${value}`, 'aria-label': `${title}: ${value}`, 'data-color': value,
    onclick: (e: Event) => openColorPicker(e.currentTarget as HTMLElement, value, cb),
  });
}
