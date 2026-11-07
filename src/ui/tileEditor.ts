// The Tile workspace's atlas panel: choose tiles from an atlas image, and the settings for putting them on a model.
import { ed } from '../core/editor';
import { makeMaterial, newId, uniqueName, type Material, type Texture } from '../core/types';
import { tileAtPixel, tileCounts, tilePixels, type TileBlock, type TileGrid, type TileTransform } from '../core/tiles';
import { openFile } from '../io/platform';
import { app } from './app';
import { button, checkbox, h, numField, svgIcon } from './dom';
import { status, toast } from './feedback';
import { onTexturesChanged, setPixelated, workingTexture } from './textureDoc';

export type TileMode = 'paint' | 'fill' | 'place' | 'erase' | 'pick';

/** Tile settings, shared by the atlas panel and the tool in the view. */
export const tiles = {
  /** The atlas texture, when chosen; otherwise the working texture is used. */
  atlasId: null as number | null,
  tileW: 16, tileH: 16, marginX: 0, marginY: 0, spacingX: 0, spacingY: 0,
  block: { col: 0, row: 0, w: 1, h: 1 } as TileBlock,
  xf: { rot: 0, flipX: false, flipY: false } as TileTransform,
  mode: 'paint' as TileMode,
  /** Paint a random tile from the chosen block on each face, instead of repeating it as a pattern. */
  random: false,
  /** Building: a tile's size in the scene, in metres. */
  cell: 1,
  /** Building on a view's own plane: how far along the view's axis it sits. Page Up and Page Down move it. */
  depth: 0,
  /** Pull each tile's edges in by half a pixel, so neighbours never bleed in when the texture is smoothed. */
  inset: false,
};

const MODE_INFO: Record<TileMode, { label: string; key: string; icon: string; hint: string }> = {
  paint: { label: 'Paint', key: 'P', icon: '<path d="M4 20l4-1 11-11-3-3L5 16z"/>', hint: 'Drag across faces to put the tile on each, fitted to the face.' },
  fill: { label: 'Fill', key: 'G', icon: '<path d="M5 11l7-7 7 7-7 7z"/><path d="M19 15c1 2 2 3 2 4a2 2 0 0 1-4 0c0-1 1-2 2-4z"/>', hint: 'Click a face to tile every face connected to it on the same flat surface.' },
  place: { label: 'Build', key: 'T', icon: '<rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><path d="M16.5 14v6M13.5 17h6"/>', hint: 'Click or drag to add tile squares: on the face under the mouse, or on the view\'s grid plane. Page Up and Page Down move that plane.' },
  erase: { label: 'Erase', key: 'E', icon: '<path d="M4 16l9-9 7 7-6 6H8z"/>', hint: 'Drag across built tiles to remove them.' },
  pick: { label: 'Pick', key: 'I', icon: '<path d="M14 4l6 6-2 2-6-6z"/><path d="M12 8l-8 8v4h4l8-8"/>', hint: 'Click a face to choose the tile it shows. Alt does this with any mode.' },
};

export function setTileMode(mode: TileMode) {
  tiles.mode = mode;
  status(`Tiles, ${MODE_INFO[mode].label}: ${MODE_INFO[mode].hint} R turns the tile, F flips it, Shift+F flips it upside down.`);
  app.tilesRefresh();
}

/** The atlas texture: the one chosen, or else the working faces' own. */
export function atlasTexture(): Texture | null {
  const m = ed.model;
  if (tiles.atlasId !== null) {
    const t = m.textures.find((x) => x.id === tiles.atlasId);
    if (t) return t;
    tiles.atlasId = null;
  }
  return workingTexture();
}

export function atlasGrid(t: Texture): TileGrid {
  return { imageW: t.width, imageH: t.height, tileW: tiles.tileW, tileH: tiles.tileH, marginX: tiles.marginX, marginY: tiles.marginY, spacingX: tiles.spacingX, spacingY: tiles.spacingY };
}

/** The material that draws the atlas, made if there isn't one. Call inside an undoable edit. */
export function atlasMaterial(m: typeof ed.model, texId: number): Material {
  const found = m.materials.find((x) => x.maps.base === texId);
  if (found) return found;
  const t = m.textures.find((x) => x.id === texId);
  const mat = makeMaterial(m, uniqueName(m.materials.map((x) => x.name), `${t?.name ?? 'Tiles'} material`), '#ffffff');
  mat.maps.base = texId;
  mat.alphaMode = 'mask';
  return mat;
}

/** Load an image as the tile atlas. */
export async function loadAtlas() {
  const f = await openFile([{ name: 'Images', extensions: ['png', 'gif', 'webp', 'bmp', 'jpg', 'jpeg'] }]);
  if (!f) return;
  const url = await new Promise<string>((res) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.readAsDataURL(new Blob([f.data]));
  });
  const size = await new Promise<[number, number] | null>((res) => {
    const im = new Image();
    im.onload = () => res([im.naturalWidth, im.naturalHeight]);
    im.onerror = () => res(null);
    im.src = url;
  });
  if (!size) { toast('That file isn\'t an image this app can read.', 'warn'); return; }
  let id = 0;
  ed.transact('Load tile atlas', (m) => {
    id = newId(m);
    m.textures.push({ id, name: f.name.replace(/\.[^.]+$/, ''), url, width: size[0], height: size[1], pixelated: true });
    atlasMaterial(m, id);
  });
  tiles.atlasId = id;
  tiles.block = { col: 0, row: 0, w: 1, h: 1 };
  app.tilesRefresh();
  app.uv?.draw();
  status(`Loaded ${f.name}, ${size[0]}×${size[1]}. Set the tile size if it isn't ${tiles.tileW}×${tiles.tileH}.`);
}

/** Step the chosen tile along the atlas, wrapping at the ends. */
export function stepTile(by: number) {
  const t = atlasTexture();
  if (!t) return;
  const { cols, rows } = tileCounts(atlasGrid(t));
  if (!cols || !rows) return;
  const i = ((tiles.block.row * cols + tiles.block.col + by) % (cols * rows) + cols * rows) % (cols * rows);
  tiles.block = { col: i % cols, row: Math.floor(i / cols), w: 1, h: 1 };
  app.tilesRefresh();
}

export function turnTile(by: 1 | -1) {
  tiles.xf = { ...tiles.xf, rot: (((tiles.xf.rot + by) % 4) + 4) % 4 as TileTransform['rot'] };
  app.tilesRefresh();
}

export function flipTile(axis: 'x' | 'y') {
  tiles.xf = axis === 'x' ? { ...tiles.xf, flipX: !tiles.xf.flipX } : { ...tiles.xf, flipY: !tiles.xf.flipY };
  app.tilesRefresh();
}

// ---------- the panel ----------
export class TileEditor {
  el: HTMLElement;
  private cv: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private bar: HTMLElement;
  private gridBar: HTMLElement;
  private readout: HTMLElement;
  private zoom = 0;
  private panX = 0;
  private panY = 0;
  private fittedFor = -1;
  private img: HTMLImageElement | null = null;
  private imgUrl = '';
  private mouse = { x: 0, y: 0, inside: false };
  private drag: { kind: 'pan'; x: number; y: number } | { kind: 'select'; col: number; row: number } | null = null;

  constructor() {
    this.cv = h('canvas', { class: 'paint-canvas', tabindex: '0' }) as HTMLCanvasElement;
    this.g = this.cv.getContext('2d')!;
    this.bar = h('div', { class: 'paint-bar' });
    this.gridBar = h('div', { class: 'paint-bar tile-grid-bar' });
    this.readout = h('span', { class: 'muted small' });
    const wrap = h('div', { class: 'uv-wrap' }, this.cv);
    this.el = h('section', { class: 'uv-editor paint-editor tile-editor', 'aria-label': 'Tile atlas' }, this.bar, this.gridBar, wrap, h('div', { class: 'uv-foot' }, this.readout));
    new ResizeObserver(() => this.draw()).observe(wrap);
    this.bind();
    onTexturesChanged(() => this.draw());
    ed.on(['selection', 'materials', 'history', 'groups'], () => { this.renderBar(); this.draw(); });
    app.tilesRefresh = () => { this.renderBar(); this.draw(); };
    this.renderBar();
  }

  private image(t: Texture): HTMLImageElement | null {
    if (t.url !== this.imgUrl) {
      this.imgUrl = t.url;
      const im = new Image();
      im.onload = () => this.draw();
      im.src = t.url;
      this.img = im;
    }
    return this.img?.complete ? this.img : null;
  }

  private fit(t: Texture) {
    const W = this.cv.clientWidth, H = this.cv.clientHeight;
    if (!W || !H) return;
    const z = Math.min(W / t.width, H / t.height) * 0.92;
    this.zoom = z >= 1 ? Math.floor(z) : z;
    this.panX = 0; this.panY = 0;
    this.fittedFor = t.id;
  }

  private origin(t: Texture): [number, number] {
    return [Math.round(this.cv.clientWidth / 2 + this.panX - (t.width * this.zoom) / 2), Math.round(this.cv.clientHeight / 2 + this.panY - (t.height * this.zoom) / 2)];
  }

  private tileUnder(t: Texture, x: number, y: number) {
    const [ox, oy] = this.origin(t);
    return tileAtPixel(atlasGrid(t), (x - ox) / this.zoom, (y - oy) / this.zoom);
  }

  draw() {
    const cv = this.cv;
    const parent = cv.parentElement!;
    const W = parent.clientWidth, H = parent.clientHeight;
    if (!W || !H || this.el.offsetParent === null) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#16181c';
    g.fillRect(0, 0, W, H);
    const t = atlasTexture();
    if (!t) {
      g.fillStyle = '#8a9099'; g.font = '13px "Segoe UI", sans-serif'; g.textAlign = 'center';
      g.fillText('Load an atlas image to choose tiles from.', W / 2, H / 2);
      this.readout.textContent = '';
      return;
    }
    const im = this.image(t);
    if (this.fittedFor !== t.id || !this.zoom) this.fit(t);
    const [ox, oy] = this.origin(t);
    const z = this.zoom;
    g.fillStyle = '#2c2f35'; g.fillRect(ox, oy, t.width * z, t.height * z);
    if (im) { g.imageSmoothingEnabled = z < 1; g.drawImage(im, ox, oy, t.width * z, t.height * z); g.imageSmoothingEnabled = true; }
    const grid = atlasGrid(t);
    const { cols, rows } = tileCounts(grid);
    // The tile grid.
    g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 1;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const [x, y, w, hh] = tilePixels(grid, c, r);
      g.strokeRect(ox + x * z + 0.5, oy + y * z + 0.5, w * z - 1, hh * z - 1);
    }
    const rectOf = (b: TileBlock) => {
      const [x0, y0] = tilePixels(grid, b.col, b.row);
      const [x1, y1, w1, h1] = tilePixels(grid, b.col + b.w - 1, b.row + b.h - 1);
      return [ox + x0 * z, oy + y0 * z, (x1 + w1 - x0) * z, (y1 + h1 - y0) * z];
    };
    // The tile under the mouse, and the chosen block.
    if (this.mouse.inside && !this.drag) {
      const hv = this.tileUnder(t, this.mouse.x, this.mouse.y);
      if (hv) { const [x, y, w, hh] = rectOf({ ...hv, w: 1, h: 1 }); g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(x, y, w, hh); }
    }
    const [bx, by, bw, bh] = rectOf(tiles.block);
    g.strokeStyle = '#f2b24c'; g.lineWidth = 2; g.strokeRect(bx + 1, by + 1, bw - 2, bh - 2);
    // The chosen tile as it will go down: turned and flipped.
    if (im) {
      const [px, py, pw, ph] = tilePixels(grid, tiles.block.col, tiles.block.row);
      const s = 56, cx = W - s / 2 - 12, cy = s / 2 + 12;
      g.save();
      g.fillStyle = 'rgba(20,22,25,0.9)'; g.fillRect(cx - s / 2 - 4, cy - s / 2 - 4, s + 8, s + 8);
      g.translate(cx, cy);
      g.rotate((tiles.xf.rot * Math.PI) / 2);
      g.scale(tiles.xf.flipX ? -1 : 1, tiles.xf.flipY ? -1 : 1);
      g.imageSmoothingEnabled = false;
      g.drawImage(im, px, py, pw, ph, -s / 2, -s / 2, s, s);
      g.restore();
    }
    const b = tiles.block;
    this.readout.textContent = `Tile ${b.col}, ${b.row}${b.w > 1 || b.h > 1 ? `  (${b.w}×${b.h} block${tiles.random ? ', random' : ', pattern'})` : ''}   ${cols}×${rows} tiles of ${grid.tileW}×${grid.tileH} in ${t.width}×${t.height}`;
  }

  renderBar() {
    const t = atlasTexture();
    const modeBtn = (m: TileMode) => {
      const info = MODE_INFO[m];
      return h('button', {
        class: `tool-btn paint-tool${tiles.mode === m ? ' active' : ''}`, title: `${info.label} (${info.key})\n${info.hint}`, 'aria-label': info.label, 'aria-pressed': String(tiles.mode === m),
        onclick: () => setTileMode(m),
      }, svgIcon(info.icon, 16));
    };
    const icon = (path: string, title: string, run: () => void, on = false) => h('button', { class: `tool-btn paint-tool${on ? ' active' : ''}`, title, 'aria-label': title, onclick: run }, svgIcon(path, 16));
    this.bar.replaceChildren(...[
      h('div', { class: 'paint-tools' }, (Object.keys(MODE_INFO) as TileMode[]).map(modeBtn)),
      h('div', { class: 'paint-tools' },
        icon('<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 3v5h-5"/>', 'Turn clockwise (R)', () => turnTile(1)),
        icon('<path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M4 3v5h5"/>', 'Turn anticlockwise (Shift+R)', () => turnTile(-1)),
        icon('<path d="M12 3v18"/><path d="M9 7L4 12l5 5zM15 7l5 5-5 5z"/>', 'Flip left to right (F)', () => flipTile('x'), tiles.xf.flipX),
        icon('<path d="M3 12h18"/><path d="M7 9l5-5 5 5zM7 15l5 5 5-5z"/>', 'Flip upside down (Shift+F)', () => flipTile('y'), tiles.xf.flipY),
      ),
      checkbox('Random', tiles.random, (v) => { tiles.random = v; this.draw(); }, 'With a block of tiles chosen: a random one on each face, instead of repeating the block as a pattern'),
      tiles.mode === 'place' ? numField({ label: 'Size', value: tiles.cell, min: 0.01, max: 100, step: 0.01, digits: 3, title: 'A built tile\'s width in metres', onChange: (v) => { tiles.cell = v; } }) : null,
      tiles.mode === 'place' ? numField({ label: 'Depth', value: tiles.depth, step: 0.01, digits: 3, title: 'Where the view\'s building plane sits along its axis. Page Up and Page Down move it a tile.', onChange: (v) => { tiles.depth = v; app.vp.invalidate(); } }) : null,
      h('span', { class: 'tl-grow' }),
      button('Load atlas…', () => { void loadAtlas(); }, { class: t ? 'btn btn-small' : 'btn btn-small btn-primary', title: 'Use an image of tiles as the atlas' }),
      t ? checkbox('Pixel art', !!t.pixelated, (v) => setPixelated(t.id, v), 'Sharp pixels in the view and in exports') : null,
      button('Fit', () => { if (t) { this.fit(t); this.draw(); } }, { class: 'btn btn-small' }),
    ].filter((x): x is HTMLElement => !!x));
    const n = (label: string, key: 'tileW' | 'tileH' | 'marginX' | 'marginY' | 'spacingX' | 'spacingY', title: string, min: number) =>
      numField({ label, value: tiles[key], min, max: 4096, step: 1, digits: 0, title, onChange: (v) => { tiles[key] = Math.round(v); this.draw(); } });
    this.gridBar.replaceChildren(
      n('Tile W', 'tileW', 'Tile width in pixels', 1), n('H', 'tileH', 'Tile height in pixels', 1),
      n('Margin X', 'marginX', 'Space before the first tile, from the left edge', 0), n('Y', 'marginY', 'Space before the first tile, from the top edge', 0),
      n('Spacing X', 'spacingX', 'Space between tiles across', 0), n('Y', 'spacingY', 'Space between tiles down', 0),
      checkbox('Inset', tiles.inset, (v) => { tiles.inset = v; }, 'Pull each tile in by half a pixel, so neighbours never bleed in on smoothed textures'),
    );
  }

  private bind() {
    const cv = this.cv;
    const pos = (e: MouseEvent) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      cv.focus({ preventScroll: true });
      cv.setPointerCapture(e.pointerId);
      const { x, y } = pos(e);
      if (e.button === 1 || e.button === 2) { this.drag = { kind: 'pan', x, y }; return; }
      const t = atlasTexture();
      const hit = t ? this.tileUnder(t, x, y) : null;
      if (!hit) return;
      tiles.block = { col: hit.col, row: hit.row, w: 1, h: 1 };
      this.drag = { kind: 'select', col: hit.col, row: hit.row };
      if (tiles.mode === 'pick' || tiles.mode === 'erase') setTileMode('paint');
      this.draw();
    });
    cv.addEventListener('pointermove', (e) => {
      const { x, y } = pos(e);
      this.mouse = { x, y, inside: true };
      const dr = this.drag;
      if (dr?.kind === 'pan') { this.panX += x - dr.x; this.panY += y - dr.y; dr.x = x; dr.y = y; }
      else if (dr?.kind === 'select') {
        // Drag out a block of tiles.
        const t = atlasTexture();
        const hit = t ? this.tileUnder(t, x, y) : null;
        if (hit) tiles.block = { col: Math.min(dr.col, hit.col), row: Math.min(dr.row, hit.row), w: Math.abs(hit.col - dr.col) + 1, h: Math.abs(hit.row - dr.row) + 1 };
      }
      this.draw();
    });
    const up = () => { this.drag = null; this.draw(); };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { this.mouse.inside = false; this.draw(); });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const t = atlasTexture();
      if (!t) return;
      const { x, y } = pos(e);
      const [ox, oy] = this.origin(t);
      const px = (x - ox) / this.zoom, py = (y - oy) / this.zoom;
      const z0 = this.zoom;
      let z = e.deltaY < 0 ? (z0 >= 1 ? Math.ceil(z0 * 1.25) : z0 * 1.25) : (z0 > 1 ? Math.floor(z0 / 1.25) : z0 / 1.25);
      z = Math.max(0.05, Math.min(64, z || z0));
      this.zoom = z;
      const [nx, ny] = this.origin(t);
      this.panX += x - (nx + px * z);
      this.panY += y - (ny + py * z);
      this.draw();
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (!this.mouse.inside || ed.workspace !== 'tiles' || e.ctrlKey || e.metaKey) return;
      const tg = e.target as HTMLElement;
      if (tg.tagName === 'INPUT' || tg.tagName === 'SELECT' || tg.tagName === 'TEXTAREA') return;
      // Immediate: the app's own shortcuts listen on the window too, and must not act on the same key.
      if (tileKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
  }
}

/** Tile shortcuts, over the atlas panel or the view in the Tile workspace. True if used. */
export function tileKey(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey) return false;
  const k = e.key.toLowerCase();
  const mode = (Object.keys(MODE_INFO) as TileMode[]).find((m) => MODE_INFO[m].key.toLowerCase() === k);
  if (mode && !e.shiftKey && !e.altKey) { setTileMode(mode); return true; }
  if (k === 'r') { turnTile(e.shiftKey ? -1 : 1); return true; }
  if (k === 'f') { flipTile(e.shiftKey ? 'y' : 'x'); return true; }
  if (k === '[' || k === ']') { stepTile(k === ']' ? 1 : -1); return true; }
  if (e.key === 'PageUp' || e.key === 'PageDown') { tiles.depth = +(tiles.depth + (e.key === 'PageUp' ? 1 : -1) * tiles.cell).toFixed(6); app.tilesRefresh(); app.vp.invalidate(); status(`Building plane at depth ${tiles.depth}.`); return true; }
  return false;
}
