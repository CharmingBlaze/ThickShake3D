// Animation timeline: clip controls, a dope sheet for arranging keys, and a graph editor for shaping motion.
import { easeOf, remapKeys, type KeyRef } from '../core/anim';
import { ed } from '../core/editor';
import { easeT, keyFrames, qFromEuler, qToEuler, sampleTrack } from '../core/skeleton';
import { uniqueName, type Clip, type Key, type Q, type Track, type V3 } from '../core/types';
import { runCommand } from './commands';
import { button, h, ICONS, numField, renderInto, select, svgIcon } from './dom';
import { status } from './feedback';
import { menuButton } from './menu';

const ROW = 20, RULER = 22, NAME_W = 150;
const SEL = '#f2b24c';
const EASE_COLOR: Record<string, string> = { linear: '#d9dee4', smooth: '#7fc8f8', in: '#7fc8f8', out: '#7fc8f8', overshoot: '#c9a2f2', anticipate: '#c9a2f2', step: '#e8855a', custom: '#8fe0a6' };
const CHANNELS = [
  { id: 'rx', label: 'Rotate X', list: 'rot', i: 0, color: '#e8555a' }, { id: 'ry', label: 'Rotate Y', list: 'rot', i: 1, color: '#7bc043' }, { id: 'rz', label: 'Rotate Z', list: 'rot', i: 2, color: '#4a90e2' },
  { id: 'px', label: 'Move X', list: 'pos', i: 0, color: '#f08a8d' }, { id: 'py', label: 'Move Y', list: 'pos', i: 1, color: '#a6d87c' }, { id: 'pz', label: 'Move Z', list: 'pos', i: 2, color: '#86b7ee' },
] as const;
type Channel = (typeof CHANNELS)[number];

const refKey = (bone: number, f: number) => `${bone}:${f}`;
const parseRef = (k: string): KeyRef => { const [bone, f] = k.split(':').map(Number); return { bone, f }; };

type Drag =
  | { type: 'scrub' }
  | { type: 'pan'; x: number; start: number }
  | { type: 'box'; x0: number; y0: number; x1: number; y1: number; add: boolean }
  | { type: 'move'; x0: number; delta: number; copy: boolean }
  | { type: 'scale'; pivot: number; grab: number; factor: number }
  | { type: 'gkey'; ch: Channel; x0: number; y0: number; f0: number; v0: number; moved: boolean }
  | { type: 'ghandle'; ch: Channel; which: 0 | 1; f: number; moved: boolean }
  /** Dragging an event flag along the ruler. */
  | { type: 'event'; index: number; moved: boolean }
  /** Shift-dragging out a play range on the ruler, or dragging one of its ends. */
  | { type: 'range'; anchor: number; moved: boolean };

const EVENT = '#7fc8f8';

/** Change the active clip as one undo step. */
function editClip(label: string, fn: (c: Clip) => void) {
  const id = ed.activeClip;
  ed.transact(label, (m) => { const c = m.clips.find((x) => x.id === id); if (c) fn(c); });
}

/** Add a named event at a frame of the active clip, asking for its name. */
export function addEvent(frame: number) {
  const c = ed.clip();
  if (!c) return;
  const name = prompt('Event name, for the game to act on (a footstep, a hit, a sound)', 'Event')?.trim();
  if (!name) return;
  editClip('Add event', (d) => { (d.events ?? (d.events = [])).push({ f: Math.round(frame), name }); d.events.sort((a, b) => a.f - b.f); });
  status(`Event "${name}" at frame ${Math.round(frame)}. Drag its flag to move it, double-click to rename, right click to remove.`);
}

/** Set one end of the active clip's play range at a frame; the other end stays, or is the clip's start or end. */
export function setRangeEnd(which: 'in' | 'out', frame: number) {
  const c = ed.clip();
  if (!c) return;
  const f = Math.round(frame);
  const [lo, hi] = c.range ?? [0, c.length];
  const r: [number, number] = which === 'in' ? [f, Math.max(f + 1, hi)] : [Math.min(lo, f - 1), f];
  editClip('Set play range', (d) => { d.range = [Math.max(0, r[0]), Math.min(d.length, r[1])]; });
}

export class Timeline {
  el: HTMLElement;
  private bar: HTMLElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private scroll = 0;
  private drag: Drag | null = null;
  private start = 0; // First visible frame.
  private ppf = 0; // Pixels per frame; 0 means fit the clip on the next draw.
  private fitClip: number | null = null;
  view: 'dope' | 'graph' = 'dope';
  speed = 1;
  private sel = new Set<string>();
  private visible = new Set<string>(['rx', 'ry', 'rz']);
  /** The graph's key in focus, whose curve handles are shown. */
  private gSel: { ch: Channel; f: number } | null = null;
  private gRange: { lo: number; hi: number } | null = null;
  private mouseInside = false;

  constructor() {
    this.bar = h('div', { class: 'tl-bar' });
    this.canvas = h('canvas', { class: 'tl-canvas', tabindex: '0' }) as HTMLCanvasElement;
    this.g = this.canvas.getContext('2d')!;
    const wrap = h('div', { class: 'tl-sheet' }, this.canvas);
    this.el = h('section', { class: 'timeline', 'aria-label': 'Timeline' }, this.bar, wrap);
    new ResizeObserver(() => this.draw()).observe(wrap);
    ed.on(['anim', 'skeleton', 'selection', 'history'], () => { this.prune(); this.renderBar(); this.draw(); });
    ed.on('time', () => { this.syncFrame(); this.draw(); });
    this.bindCanvas();
    this.renderBar();
  }

  private frameInput: HTMLInputElement | null = null;
  private timeLabel: HTMLElement | null = null;
  private playBtn: HTMLElement | null = null;

  private syncFrame() {
    const c = ed.clip();
    if (this.frameInput && document.activeElement !== this.frameInput) this.frameInput.value = String(Math.round(ed.frame));
    if (this.timeLabel && c) this.timeLabel.textContent = `${(ed.frame / c.fps).toFixed(2)}s`;
    this.playBtn?.replaceChildren(svgIcon(ed.playing ? ICONS.pause : ICONS.play, 14));
  }

  private renderBar() {
    const c = ed.clip();
    renderInto(this.bar, () => {
      const m = ed.model;
      const frameField = numField({ value: Math.round(ed.frame), digits: 0, min: 0, max: c?.length ?? 0, title: 'Current frame', onChange: (v) => { ed.frame = v; ed.emit('time'); } });
      this.frameInput = frameField.querySelector('input');
      this.timeLabel = h('span', { class: 'muted small tl-time', title: 'Time at this frame' }, c ? `${(ed.frame / c.fps).toFixed(2)}s` : '');
      this.playBtn = button(svgIcon(ed.playing ? ICONS.pause : ICONS.play, 14), () => runCommand('anim.play'), { class: 'tl-btn tl-play', title: 'Play / Pause (P)' });
      const viewBtn = (v: 'dope' | 'graph', label: string, title: string) => h('button', { class: `seg-btn${this.view === v ? ' active' : ''}`, title, onclick: () => this.setView(v) }, label);
      return [
        c ? select<number>(c.id, m.clips.map((x): [number, string] => [x.id, x.name]), (v) => { ed.activeClip = v; ed.frame = 0; this.sel.clear(); this.ppf = 0; ed.emit('anim', 'time'); }, 'Active clip') : h('span', { class: 'muted small tl-none' }, 'No clips yet'),
        c ? null : button('New clip', () => runCommand('anim.newClip'), { class: 'btn btn-primary btn-small' }),
        menuButton('Clip', ['anim.newClip', 'anim.rename', 'anim.duplicateClip', 'anim.deleteClip', null, 'anim.makeLoop', 'anim.mirrorClip', 'anim.reverse', 'anim.retime', null, 'anim.reduce', 'anim.bake', 'anim.fitLength']),
        h('span', { class: 'tl-sep' }),
        button(svgIcon(ICONS.first, 14), () => { ed.frame = 0; ed.emit('time'); }, { class: 'tl-btn', title: 'First frame' }),
        button(svgIcon(ICONS.prevKey, 14), () => runCommand('anim.prevKey'), { class: 'tl-btn', title: 'Previous keyframe (Shift+Left)' }),
        this.playBtn,
        button(svgIcon(ICONS.nextKey, 14), () => runCommand('anim.nextKey'), { class: 'tl-btn', title: 'Next keyframe (Shift+Right)' }),
        button(svgIcon(ICONS.last, 14), () => { ed.frame = c?.length ?? 0; ed.emit('time'); }, { class: 'tl-btn', title: 'Last frame' }),
        frameField,
        this.timeLabel,
        select<number>(this.speed, [[0.25, '25%'], [0.5, '50%'], [1, '100%'], [2, '200%']], (v) => { this.speed = v; }, 'Playback speed'),
        h('span', { class: 'tl-sep' }),
        button([svgIcon(ICONS.plus, 12), 'Key'], () => runCommand('anim.key'), { class: 'btn btn-small', title: 'Key selected joints here (K)' }),
        button([svgIcon(ICONS.minus, 12), 'Key'], () => runCommand('anim.deleteKey'), { class: 'btn btn-small', title: 'Remove keys at this frame (Shift+K)' }),
        menuButton('Curve', ['anim.ease.linear', 'anim.ease.smooth', 'anim.ease.in', 'anim.ease.out', 'anim.ease.overshoot', 'anim.ease.anticipate', 'anim.ease.step']),
        menuButton('Pose', ['anim.copyPose', 'anim.pastePose', 'anim.pasteMirrored', 'anim.mirrorPose', 'anim.resetPose']),
        menuButton('View', ['anim.frameAll', null, 'anim.onion', 'anim.trail', 'anim.togglePose']),
        c ? button('Event', () => addEvent(ed.frame), { class: 'btn btn-small', title: 'Add a named event at this frame for the game to act on (E over the timeline). Double-click the ruler to add one there.' }) : null,
        c?.range
          ? h('span', { class: 'tl-range', title: 'Playback loops on this stretch. Drag its ends on the ruler; Shift-drag the ruler for a new one; I and O set its ends.' },
            `Range ${c.range[0]}–${c.range[1]}`,
            button('×', () => editClip('Clear play range', (d) => { delete d.range; }), { class: 'tl-btn', title: 'Play the whole clip again' }))
          : null,
        h('div', { class: 'seg' }, viewBtn('dope', 'Keys', 'Arrange keys over time'), viewBtn('graph', 'Curves', 'Shape the motion between keys')),
        h('span', { class: 'tl-grow' }),
        c ? numField({ label: 'FPS', value: c.fps, min: 1, max: 240, step: 1, digits: 0, onChange: (v) => ed.transact('Set FPS', (d) => { d.clips.find((x) => x.id === c.id)!.fps = v; }) }) : null,
        c ? numField({ label: 'End', value: c.length, min: 1, max: 100000, step: 1, digits: 0, onChange: (v) => { ed.transact('Set clip length', (d) => { d.clips.find((x) => x.id === c.id)!.length = v; }); this.ppf = 0; } }) : null,
        c ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: c.loop, onchange: (e: Event) => { const on = (e.target as HTMLInputElement).checked; ed.transact('Loop', (d) => { d.clips.find((x) => x.id === c.id)!.loop = on; }); } }), h('span', null, 'Loop')) : null,
      ];
    });
  }

  setView(v: 'dope' | 'graph') {
    this.view = v;
    this.gRange = null;
    this.scroll = 0;
    this.renderBar();
    this.draw();
  }

  rename() {
    const c = ed.clip();
    if (!c) return;
    const input = h('input', { class: 'rename', value: c.name, 'aria-label': 'Clip name' }) as HTMLInputElement;
    const sel = this.bar.querySelector('select');
    if (!sel) return;
    let finished = false;
    const done = (ok: boolean) => {
      if (finished) return;
      finished = true;
      const v = input.value.trim();
      input.blur();
      if (ok && v && v !== c.name) ed.transact('Rename clip', (d) => { d.clips.find((x) => x.id === c.id)!.name = uniqueName(d.clips.filter((x) => x.id !== c.id).map((x) => x.name), v); });
      else this.renderBar();
    };
    input.addEventListener('blur', () => done(true));
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    sel.replaceWith(input);
    input.focus();
    input.select();
  }

  /** Update playback; called once per display frame. */
  tick(dt: number) {
    if (!ed.playing) return;
    const c = ed.clip();
    if (!c) { ed.playing = false; return; }
    // A play range loops on its own stretch, whether or not the clip loops.
    const [lo, hi] = c.range ?? [0, c.length];
    let f = ed.frame + dt * c.fps * this.speed;
    if (c.range && (f < lo || ed.frame > hi)) f = lo;
    if (f >= hi) {
      if (c.loop || c.range) f = lo + ((f - lo) % Math.max(1, hi - lo));
      else { f = hi; ed.playing = false; }
    }
    ed.frame = f;
    ed.emit('time');
  }

  // ---------- selection for commands ----------
  private prune() {
    const c = ed.clip();
    for (const k of this.sel) {
      const { bone, f } = parseRef(k);
      const t = c?.tracks[bone];
      if (!t || !(t.rot.some((x) => x.f === f) || t.pos.some((x) => x.f === f))) this.sel.delete(k);
    }
    if (this.gSel && !this.gKeys(this.gSel.ch).some((k) => k.f === this.gSel!.f)) this.gSel = null;
  }

  /** Selected keys; failing that, the keys at this frame on the selected joints. */
  targets(): KeyRef[] {
    if (this.sel.size) return [...this.sel].map(parseRef);
    const c = ed.clip();
    if (!c) return [];
    const f = Math.round(ed.frame);
    const ids = ed.selBones.size ? [...ed.selBones] : Object.keys(c.tracks).map(Number);
    return ids.filter((id) => { const t = c.tracks[id]; return t && (t.rot.some((k) => k.f === f) || t.pos.some((k) => k.f === f)); }).map((bone) => ({ bone, f }));
  }
  get selectionSize() { return this.sel.size; }
  selectRefs(refs: KeyRef[]) { this.sel = new Set(refs.map((r) => refKey(r.bone, r.f))); this.draw(); }
  clearSelection() { this.sel.clear(); this.draw(); }

  // ---------- time axis ----------
  private rows() {
    const c = ed.clip();
    if (!c) return [];
    // Parents first, so the list reads as the hierarchy.
    const out: { id: number; name: string; depth: number }[] = [];
    const walk = (parent: number | null, depth: number) => {
      for (const b of ed.model.bones.filter((x) => x.parent === parent)) {
        if (ed.selBones.has(b.id) || c.tracks[b.id]?.rot.length || c.tracks[b.id]?.pos.length) out.push({ id: b.id, name: b.name, depth });
        walk(b.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }

  private fit(W: number, c: Clip) {
    this.ppf = (W - NAME_W - 24) / Math.max(1, c.length);
    this.start = 0;
    this.fitClip = c.id;
  }
  frameAll() { this.ppf = 0; this.gRange = null; this.draw(); }
  private xOf(f: number) { return NAME_W + 8 + (f - this.start) * this.ppf; }
  /** The event flag under x on the ruler, or -1. */
  private eventAt(x: number, c: Clip): number {
    return (c.events ?? []).findIndex((ev) => x >= this.xOf(ev.f) - 3 && x <= this.xOf(ev.f) + 8);
  }
  private frameAt(x: number, c: Clip) { return Math.max(0, Math.min(c.length, Math.round((x - NAME_W - 8) / this.ppf + this.start))); }

  // ---------- drawing ----------
  draw() {
    const cv = this.canvas;
    const parent = cv.parentElement!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = parent.clientWidth, H = parent.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = `${W}px`; cv.style.height = `${H}px`; }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#17191c'; g.fillRect(0, 0, W, H);
    const c = ed.clip();
    g.font = '11px "Segoe UI", sans-serif';
    g.textBaseline = 'middle';
    if (!c) {
      g.fillStyle = '#7d858f';
      g.fillText(ed.model.bones.length ? 'Create a clip to start animating.' : 'Add joints in the Rigging workspace, then create a clip here.', 16, 20);
      return;
    }
    if (!this.ppf || this.fitClip !== c.id) this.fit(W, c);

    // Everything past the clip's end is shaded, since it won't play.
    const endX = this.xOf(c.length);
    if (endX < W) { g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(Math.max(NAME_W, endX), RULER, W, H); }

    if (this.view === 'graph') this.drawGraph(W, H, c);
    else this.drawDope(W, H, c);

    // Ruler on top of either view.
    g.fillStyle = '#1e2125'; g.fillRect(0, 0, W, RULER);
    const step = niceStep(this.ppf);
    const first = Math.max(0, Math.ceil(this.start / step) * step);
    g.textAlign = 'center';
    for (let f = first; this.xOf(f) < W; f += step) {
      const x = this.xOf(f);
      if (x < NAME_W) continue;
      g.strokeStyle = '#2b2f35';
      g.beginPath(); g.moveTo(x + 0.5, RULER - 5); g.lineTo(x + 0.5, RULER); g.stroke();
      g.fillStyle = f > c.length ? '#565c64' : '#8c949e';
      g.fillText(String(f), x, RULER / 2 - 1);
    }
    g.textAlign = 'start';
    // The play range: tinted on the ruler, the rest of the sheet dimmed.
    if (c.range) {
      const a = Math.max(NAME_W, this.xOf(c.range[0])), b = Math.max(NAME_W, this.xOf(c.range[1]));
      g.fillStyle = 'rgba(0,0,0,0.22)';
      g.fillRect(NAME_W, RULER, Math.max(0, a - NAME_W), H - RULER);
      g.fillRect(b, RULER, Math.max(0, W - b), H - RULER);
      g.fillStyle = 'rgba(143,224,166,0.18)'; g.fillRect(a, 0, Math.max(0, b - a), RULER);
      g.fillStyle = '#8fe0a6';
      for (const x of [a, b]) if (x > NAME_W) g.fillRect(x - 1, 0, 2, RULER);
    }
    // Events, as flags along the ruler's foot, named where there's room.
    for (const ev of c.events ?? []) {
      const x = this.xOf(ev.f);
      if (x < NAME_W || x > W) continue;
      g.strokeStyle = EVENT; g.fillStyle = EVENT;
      g.beginPath(); g.moveTo(x + 0.5, RULER - 11); g.lineTo(x + 0.5, H); g.globalAlpha = 0.35; g.stroke(); g.globalAlpha = 1;
      g.beginPath(); g.moveTo(x, RULER - 11); g.lineTo(x + 7, RULER - 8); g.lineTo(x, RULER - 5); g.closePath(); g.fill();
      g.font = '10px "Segoe UI", sans-serif';
      g.fillText(ev.name, x + 9, RULER - 8, Math.max(20, 120));
      g.font = '11px "Segoe UI", sans-serif';
    }
    g.fillStyle = '#1e2125'; g.fillRect(0, 0, NAME_W, RULER);
    g.strokeStyle = '#2b2f35'; g.beginPath(); g.moveTo(NAME_W + 0.5, 0); g.lineTo(NAME_W + 0.5, H); g.stroke();

    const px = this.xOf(ed.frame);
    if (px >= NAME_W) {
      g.strokeStyle = SEL; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke();
      g.fillStyle = SEL;
      g.beginPath(); g.moveTo(px - 5, 0); g.lineTo(px + 5, 0); g.lineTo(px, 8); g.closePath(); g.fill();
      g.lineWidth = 1;
    }
  }

  private previewFrame(f: number) {
    const d = this.drag;
    if (d?.type === 'move') return f + d.delta;
    if (d?.type === 'scale') return Math.round(d.pivot + (f - d.pivot) * d.factor);
    return f;
  }

  private drawDope(W: number, H: number, c: Clip) {
    const g = this.g;
    const step = niceStep(this.ppf);
    for (let f = Math.max(0, Math.ceil(this.start / step) * step); this.xOf(f) < W; f += step) {
      const x = this.xOf(f);
      if (x < NAME_W) continue;
      g.strokeStyle = '#22252a';
      g.beginPath(); g.moveTo(x + 0.5, RULER); g.lineTo(x + 0.5, H); g.stroke();
    }
    const rows = this.rows();
    const maxScroll = Math.max(0, (rows.length + 1) * ROW + RULER - H);
    this.scroll = Math.min(this.scroll, maxScroll);
    g.save();
    g.beginPath(); g.rect(0, RULER, W, H - RULER); g.clip();
    const y0 = RULER - this.scroll;
    const drawRow = (i: number, name: string, depth: number, bone: number | null, active: boolean) => {
      const y = y0 + i * ROW;
      if (y > H || y + ROW < RULER) return;
      if (active) { g.fillStyle = 'rgba(242,178,76,.08)'; g.fillRect(0, y, W, ROW); }
      g.strokeStyle = '#22252a'; g.beginPath(); g.moveTo(0, y + ROW - 0.5); g.lineTo(W, y + ROW - 0.5); g.stroke();
      g.fillStyle = active ? SEL : bone === null ? '#c9cdd3' : '#a4abb4';
      g.fillText(name, 10 + depth * 9, y + ROW / 2, NAME_W - 14 - depth * 9);
      g.save();
      g.beginPath(); g.rect(NAME_W, y, W - NAME_W, ROW); g.clip();
      const frames = bone === null ? keyFrames(c) : keyFrames(c, bone);
      const t = bone !== null ? c.tracks[bone] : undefined;
      // A bar between keys shows a held or eased stretch at a glance.
      if (t) {
        const list: Key<unknown>[] = t.rot.length ? t.rot : t.pos;
        list.forEach((k, n) => {
          const next = list[n + 1];
          if (!next || (!k.step && !k.c)) return;
          g.fillStyle = k.step ? 'rgba(232,133,90,.28)' : 'rgba(127,200,248,.16)';
          g.fillRect(this.xOf(k.f), y + ROW / 2 - 2, this.xOf(next.f) - this.xOf(k.f), 4);
        });
      }
      for (const f of frames) {
        const selected = bone === null ? this.anyAtFrame(f) : this.sel.has(refKey(bone, f));
        const pf = selected ? this.previewFrame(f) : f;
        const x = this.xOf(pf);
        const r = bone === null ? 3.5 : 4.5;
        g.beginPath();
        g.moveTo(x, y + ROW / 2 - r); g.lineTo(x + r, y + ROW / 2); g.lineTo(x, y + ROW / 2 + r); g.lineTo(x - r, y + ROW / 2); g.closePath();
        const key: Key<unknown> | undefined = t?.rot.find((k) => k.f === f) ?? t?.pos.find((k) => k.f === f);
        g.fillStyle = selected ? SEL : bone === null ? '#8fa0b3' : EASE_COLOR[key ? easeOf(key) : 'linear'];
        g.fill();
      }
      g.restore();
    };
    drawRow(0, 'All joints', 0, null, false);
    rows.forEach((b, i) => drawRow(i + 1, b.name, b.depth, b.id, ed.selBones.has(b.id)));
    g.restore();

    // The selection's span, whose ends drag to stretch the timing.
    const span = this.selectionSpan();
    if (span && (!this.drag || this.drag.type !== 'box')) {
      const a = this.xOf(this.previewFrame(span.lo)), b = this.xOf(this.previewFrame(span.hi));
      g.fillStyle = 'rgba(242,178,76,.07)';
      g.fillRect(a, RULER, b - a, H - RULER);
      g.fillStyle = SEL;
      for (const x of [a, b]) g.fillRect(x - 1.5, RULER, 3, H - RULER);
    }
    if (this.drag?.type === 'box') {
      const d = this.drag;
      g.strokeStyle = SEL; g.fillStyle = 'rgba(242,178,76,.12)'; g.setLineDash([4, 3]);
      g.fillRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      g.strokeRect(Math.min(d.x0, d.x1) + 0.5, Math.min(d.y0, d.y1) + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      g.setLineDash([]);
    }
  }

  private anyAtFrame(f: number) {
    for (const k of this.sel) if (parseRef(k).f === f) return true;
    return false;
  }

  private selectionSpan() {
    if (this.sel.size < 2) return null;
    const fs = [...this.sel].map((k) => parseRef(k).f);
    const lo = Math.min(...fs), hi = Math.max(...fs);
    return hi > lo ? { lo, hi } : null;
  }

  // ---------- graph editor ----------
  private graphBone(): number | null {
    if (ed.activeBone !== null && ed.model.bones.some((b) => b.id === ed.activeBone)) return ed.activeBone;
    return [...ed.selBones][0] ?? null;
  }

  private gKeys(ch: Channel): Key<unknown>[] {
    const c = ed.clip(), b = this.graphBone();
    const t = c && b !== null ? c.tracks[b] : undefined;
    return t ? t[ch.list] : [];
  }

  /** A channel's value over the clip, in degrees or units. Rotation unwraps so curves don't jump at 180 degrees. */
  private series(t: Track, ch: Channel, c: Clip, step: number): { step: number; values: number[] } {
    const raw = (f: number) => (ch.list === 'rot' ? qToEuler(sampleTrack(t, f).rot)[ch.i] : sampleTrack(t, f).pos[ch.i]);
    const values: number[] = [];
    let prev = 0;
    for (let i = 0; i * step <= c.length; i++) {
      let v = raw(i * step);
      if (ch.list === 'rot' && i) { while (v - prev > 180) v -= 360; while (v - prev < -180) v += 360; }
      values.push(v);
      prev = v;
    }
    return { step, values };
  }

  private sampleStep(c: Clip) { return this.ppf > 16 ? 0.25 : this.ppf > 6 ? 0.5 : Math.max(1, Math.floor(1 / this.ppf)) * (c.length > 4000 ? 2 : 1); }

  private ensureRange(t: Track, c: Clip) {
    if (this.gRange) return this.gRange;
    let lo = Infinity, hi = -Infinity;
    for (const ch of CHANNELS) {
      if (!this.visible.has(ch.id) || !t[ch.list].length) continue;
      for (const v of this.series(t, ch, c, this.sampleStep(c)).values) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }
    if (!Number.isFinite(lo)) { lo = -1; hi = 1; }
    const pad = Math.max((hi - lo) * 0.15, 0.05);
    return (this.gRange = { lo: lo - pad, hi: hi + pad });
  }

  private yOf(v: number, H: number) {
    const r = this.gRange!;
    return RULER + 10 + (1 - (v - r.lo) / (r.hi - r.lo)) * (H - RULER - 20);
  }
  private valueAt(y: number, H: number) {
    const r = this.gRange!;
    return r.lo + (1 - (y - RULER - 10) / (H - RULER - 20)) * (r.hi - r.lo);
  }

  private keyValue(t: Track, ch: Channel, c: Clip, f: number, step: number, values: number[]) {
    const i = Math.round(f / step);
    return values[i] ?? (ch.list === 'rot' ? qToEuler(sampleTrack(t, f).rot)[ch.i] : sampleTrack(t, f).pos[ch.i]);
  }

  /** On-screen positions of a key's two curve handles, or null if it has no next key. */
  private handlePositions(t: Track, ch: Channel, c: Clip, f: number, H: number) {
    const list = t[ch.list] as Key<unknown>[];
    const i = list.findIndex((k) => k.f === f);
    const a = list[i], b = list[i + 1];
    if (!a || !b || a.step) return null;
    const { step, values } = this.series(t, ch, c, this.sampleStep(c));
    const v0 = this.keyValue(t, ch, c, a.f, step, values), v1 = this.keyValue(t, ch, c, b.f, step, values);
    const r = this.gRange!;
    const dv = Math.abs(v1 - v0) > 1e-6 ? v1 - v0 : (r.hi - r.lo) * 0.25;
    const cv = a.c ?? [1 / 3, 1 / 3, 2 / 3, 2 / 3];
    const dt = b.f - a.f;
    return {
      a, b, v0, dv, dt,
      p0: { x: this.xOf(a.f), y: this.yOf(v0, H) },
      p1: { x: this.xOf(b.f), y: this.yOf(v0 + dv, H) },
      h0: { x: this.xOf(a.f + cv[0] * dt), y: this.yOf(v0 + cv[1] * dv, H) },
      h1: { x: this.xOf(a.f + cv[2] * dt), y: this.yOf(v0 + cv[3] * dv, H) },
    };
  }

  private drawGraph(W: number, H: number, c: Clip) {
    const g = this.g;
    const bone = this.graphBone();
    const b = ed.model.bones.find((x) => x.id === bone);
    // Channel list.
    CHANNELS.forEach((ch, i) => {
      const y = RULER + i * ROW;
      const on = this.visible.has(ch.id);
      g.fillStyle = on ? ch.color : '#3b4047';
      g.fillRect(10, y + 6, 8, 8);
      g.fillStyle = on ? '#c9cdd3' : '#6c737c';
      g.fillText(ch.label, 24, y + ROW / 2);
    });
    if (!b) {
      g.fillStyle = '#7d858f';
      g.fillText('Select a joint to see its curves.', NAME_W + 16, RULER + 20);
      return;
    }
    g.fillStyle = SEL;
    g.fillText(b.name, 10, RULER + CHANNELS.length * ROW + ROW / 2, NAME_W - 14);
    const t = c.tracks[b.id] ?? { rot: [], pos: [] };
    this.ensureRange(t, c);
    g.save();
    g.beginPath(); g.rect(NAME_W + 1, RULER, W - NAME_W, H - RULER); g.clip();

    // Value grid.
    const r = this.gRange!;
    const span = r.hi - r.lo;
    const gs = niceValueStep(span / Math.max(2, (H - RULER) / 36));
    g.textAlign = 'start';
    for (let v = Math.ceil(r.lo / gs) * gs; v <= r.hi; v += gs) {
      const y = Math.round(this.yOf(v, H)) + 0.5;
      g.strokeStyle = Math.abs(v) < gs * 0.01 ? '#3b4047' : '#22252a';
      g.beginPath(); g.moveTo(NAME_W, y); g.lineTo(W, y); g.stroke();
      g.fillStyle = '#6c737c';
      g.fillText(fmtValue(v, gs), NAME_W + 5, y - 7);
    }

    const step = this.sampleStep(c);
    for (const ch of CHANNELS) {
      if (!this.visible.has(ch.id) || !t[ch.list].length) continue;
      const { values } = this.series(t, ch, c, step);
      g.strokeStyle = ch.color; g.lineWidth = 1.5;
      g.beginPath();
      values.forEach((v, i) => { const x = this.xOf(i * step), y = this.yOf(v, H); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      g.stroke();
      g.lineWidth = 1;
      for (const k of t[ch.list] as Key<unknown>[]) {
        const x = this.xOf(k.f), y = this.yOf(this.keyValue(t, ch, c, k.f, step, values), H);
        const focused = this.gSel?.ch.id === ch.id && this.gSel.f === k.f;
        g.fillStyle = focused ? SEL : '#e8ecf0';
        g.strokeStyle = '#111';
        g.beginPath(); g.arc(x, y, focused ? 5 : 4, 0, 7); g.fill(); g.stroke();
      }
    }
    // Curve handles of the focused key.
    if (this.gSel && this.visible.has(this.gSel.ch.id)) {
      const hp = this.handlePositions(t, this.gSel.ch, c, this.gSel.f, H);
      if (hp) {
        g.strokeStyle = SEL; g.fillStyle = SEL; g.lineWidth = 1;
        g.setLineDash([3, 3]);
        g.beginPath(); g.moveTo(hp.p0.x, hp.p0.y); g.lineTo(hp.h0.x, hp.h0.y); g.moveTo(hp.p1.x, hp.p1.y); g.lineTo(hp.h1.x, hp.h1.y); g.stroke();
        g.setLineDash([]);
        for (const p of [hp.h0, hp.h1]) { g.fillRect(p.x - 4, p.y - 4, 8, 8); }
      }
    }
    g.restore();
  }

  private setGraphValue(t: Track, ch: Channel, f: number, v: number) {
    if (ch.list === 'rot') {
      const k = t.rot.find((x) => x.f === f);
      if (!k) return;
      const e = qToEuler(k.v);
      e[ch.i] = v;
      k.v = qFromEuler(e[0], e[1], e[2]) as Q;
    } else {
      const k = t.pos.find((x) => x.f === f);
      if (k) { (k.v as V3)[ch.i] = v; }
    }
  }

  // ---------- input ----------
  private dopeRowAt(y: number) { return Math.floor((y - RULER + this.scroll) / ROW); }

  private dopeKeyAt(x: number, y: number, c: Clip): { bone: number | null; f: number } | null {
    const idx = this.dopeRowAt(y);
    const rows = this.rows();
    if (idx < 0 || idx > rows.length) return null;
    const bone = idx === 0 ? null : rows[idx - 1].id;
    const frames = bone === null ? keyFrames(c) : keyFrames(c, bone);
    let best: number | null = null, bd = 7;
    for (const f of frames) { const d = Math.abs(this.xOf(f) - x); if (d < bd) { bd = d; best = f; } }
    return best === null ? null : { bone, f: best };
  }

  private bindCanvas() {
    const cv = this.canvas;
    const pos = (e: MouseEvent) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }; };
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerenter', () => {
      this.mouseInside = true;
      const a = document.activeElement as HTMLElement | null;
      if (a?.tagName !== 'INPUT' && a?.tagName !== 'TEXTAREA' && !document.querySelector('.modal-back, .palette-back')) cv.focus({ preventScroll: true });
    });
    cv.addEventListener('pointerleave', () => { this.mouseInside = false; if (!this.drag && document.activeElement === cv) cv.blur(); });
    cv.addEventListener('keydown', (e) => this.onKey(e));
    cv.addEventListener('dblclick', (e) => {
      const c = ed.clip();
      const { x, y } = pos(e);
      if (!c || y > RULER) return;
      const ev = this.eventAt(x, c);
      if (ev < 0) { if (x > NAME_W) addEvent(this.frameAt(x, c)); return; }
      const name = prompt('Event name', c.events![ev].name)?.trim();
      if (name) editClip('Rename event', (d) => { if (d.events?.[ev]) d.events[ev].name = name; });
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const c = ed.clip();
      if (!c) return;
      const { x } = pos(e);
      if (e.ctrlKey) {
        const at = (x - NAME_W - 8) / this.ppf + this.start;
        this.ppf = Math.max(0.05, Math.min(120, this.ppf * (e.deltaY > 0 ? 0.87 : 1.15)));
        this.start = at - (x - NAME_W - 8) / this.ppf;
        this.gRange = null;
      } else if (e.shiftKey) this.start += (e.deltaY / this.ppf) * 0.5;
      else if (this.view === 'dope') this.scroll = Math.max(0, this.scroll + e.deltaY * 0.5);
      else {
        // In the graph the wheel zooms the values.
        const r = this.gRange;
        if (r) { const mid = (r.lo + r.hi) / 2, half = ((r.hi - r.lo) / 2) * (e.deltaY > 0 ? 1.15 : 0.87); this.gRange = { lo: mid - half, hi: mid + half }; }
      }
      this.draw();
    }, { passive: false });
    cv.addEventListener('pointerdown', (e) => {
      cv.focus({ preventScroll: true });
      const c = ed.clip();
      if (!c) return;
      const { x, y, h: H } = pos(e);
      // A right click on an event flag removes it.
      if (e.button === 2 && y <= RULER) {
        const ev = this.eventAt(x, c);
        if (ev >= 0) { const name = c.events![ev].name; editClip('Remove event', (d) => { d.events?.splice(ev, 1); }); status(`Removed event "${name}".`); return; }
      }
      if (e.button === 1 || e.button === 2) { this.drag = { type: 'pan', x, start: this.start }; return; }
      if (e.button !== 0) return;
      if (y <= RULER && x > NAME_W) {
        // An event flag: drag to move it.
        const ev = this.eventAt(x, c);
        if (ev >= 0) { ed.begin('Move event'); this.drag = { type: 'event', index: ev, moved: false }; return; }
        // An end of the play range: drag to move it.
        if (c.range) {
          for (const [end, other] of [[0, 1], [1, 0]] as const) {
            if (Math.abs(this.xOf(c.range[end]) - x) < 5) { ed.begin('Set play range'); this.drag = { type: 'range', anchor: c.range[other], moved: false }; return; }
          }
        }
        // Shift: drag out a play range.
        if (e.shiftKey) { ed.begin('Set play range'); this.drag = { type: 'range', anchor: this.frameAt(x, c), moved: false }; return; }
        this.drag = { type: 'scrub' }; ed.frame = this.frameAt(x, c); ed.emit('time'); return;
      }
      if (this.view === 'graph') { this.graphDown(x, y, H, c); return; }
      if (x < NAME_W) {
        const idx = this.dopeRowAt(y) - 1;
        const b = this.rows()[idx];
        if (b) {
          ed.activeBone = b.id;
          if (e.ctrlKey || e.shiftKey) { if (ed.selBones.has(b.id)) ed.selBones.delete(b.id); else ed.selBones.add(b.id); }
          else ed.selBones = new Set([b.id]);
          ed.mode = 'bone';
          ed.emit('selection', 'skeleton', 'tool');
        }
        return;
      }
      // The ends of the selection's span stretch its timing.
      const span = this.selectionSpan();
      const hit = this.dopeKeyAt(x, y, c);
      if (span && !hit && !e.shiftKey) {
        for (const [grab, pivot] of [[span.lo, span.hi], [span.hi, span.lo]]) {
          if (Math.abs(this.xOf(grab) - x) < 5) { this.drag = { type: 'scale', pivot, grab, factor: 1 }; return; }
        }
      }
      if (hit) {
        const refs = hit.bone === null
          ? Object.entries(c.tracks).filter(([, t]) => t.rot.some((k) => k.f === hit.f) || t.pos.some((k) => k.f === hit.f)).map(([id]) => refKey(+id, hit.f))
          : [refKey(hit.bone, hit.f)];
        const allSel = refs.every((k) => this.sel.has(k));
        if (e.shiftKey) { refs.forEach((k) => { if (allSel) this.sel.delete(k); else this.sel.add(k); }); }
        else if (!allSel) this.sel = new Set(refs);
        ed.frame = hit.f;
        ed.emit('time');
        if (!e.shiftKey) this.drag = { type: 'move', x0: x, delta: 0, copy: e.ctrlKey };
        this.draw();
        return;
      }
      this.drag = { type: 'box', x0: x, y0: y, x1: x, y1: y, add: e.shiftKey };
      if (!e.shiftKey) this.sel.clear();
      this.draw();
    });
    window.addEventListener('pointermove', (e) => {
      const c = ed.clip();
      const d = this.drag;
      if (!c || !d) return;
      const { x, y, h: H } = pos(e);
      switch (d.type) {
        case 'scrub': ed.frame = this.frameAt(x, c); ed.emit('time'); return;
        case 'event': {
          const ev = ed.clip()?.events?.[d.index];
          if (!ev) return;
          const f = this.frameAt(x, c);
          if (f !== ev.f) { ev.f = f; d.moved = true; status(`${ev.name} at frame ${f}`); }
          break;
        }
        case 'range': {
          const clip = ed.clip();
          if (!clip) return;
          const f = this.frameAt(x, c);
          if (f === d.anchor && !d.moved) return;
          clip.range = [Math.min(d.anchor, f), Math.max(d.anchor + (f === d.anchor ? 1 : 0), f)];
          d.moved = true;
          status(`Play range ${clip.range[0]} to ${clip.range[1]}`);
          break;
        }
        case 'pan': this.start = d.start - (x - d.x) / this.ppf; break;
        case 'box': d.x1 = x; d.y1 = y; break;
        case 'move': {
          d.delta = Math.round((x - d.x0) / this.ppf);
          const lo = Math.min(...[...this.sel].map((k) => parseRef(k).f));
          if (lo + d.delta < 0) d.delta = -lo;
          d.copy = e.ctrlKey;
          status(`${d.copy ? 'Copy' : 'Move'} keys ${d.delta >= 0 ? '+' : ''}${d.delta} frames   (Ctrl: copy)`);
          break;
        }
        case 'scale': {
          const span = d.grab - d.pivot;
          const to = (x - NAME_W - 8) / this.ppf + this.start;
          d.factor = Math.abs(span) > 0 ? Math.max(0, (to - d.pivot) / span) : 1;
          status(`Stretch keys ${Math.round(d.factor * 100)}%`);
          break;
        }
        case 'gkey': this.graphMoveKey(d, x, y, H, c, e); break;
        case 'ghandle': this.graphMoveHandle(d, x, y, H, c); break;
      }
      this.draw();
    });
    const end = (e: PointerEvent) => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      const c = ed.clip();
      if (d.type === 'box' && c) {
        const lo = Math.min(d.x0, d.x1), hi = Math.max(d.x0, d.x1);
        const top = Math.min(d.y0, d.y1), bottom = Math.max(d.y0, d.y1);
        const rows = this.rows();
        const take = (bone: number) => keyFrames(c, bone).forEach((f) => { const px = this.xOf(f); if (px >= lo && px <= hi) this.sel.add(refKey(bone, f)); });
        const first = this.dopeRowAt(top), last = this.dopeRowAt(bottom);
        // A click on empty sheet just clears; a real box selects.
        if (hi - lo > 2 || bottom - top > 2) {
          if (first <= 0) rows.forEach((r) => take(r.id));
          for (let i = Math.max(1, first); i <= last; i++) { const r = rows[i - 1]; if (r) take(r.id); }
        }
      } else if (d.type === 'move' && d.delta !== 0) {
        this.applyRemap((f) => f + d.delta, d.copy);
      } else if (d.type === 'scale' && Math.abs(d.factor - 1) > 1e-3) {
        this.applyRemap((f) => Math.round(d.pivot + (f - d.pivot) * d.factor), false);
      } else if ((d.type === 'gkey' || d.type === 'ghandle') && d.moved) {
        ed.commit();
        ed.emitAll();
      } else if (d.type === 'event' || d.type === 'range') {
        if (d.moved) {
          if (d.type === 'event') ed.clip()?.events?.sort((a, b) => a.f - b.f);
          ed.commit(); ed.emitAll(); status('');
        } else ed.cancel();
      }
      if (d.type === 'move' || d.type === 'scale') status('');
      void e;
      this.draw();
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  /** Move the selected keys. The selection updates first, so it follows them through the refresh the edit triggers. */
  private applyRemap(to: (f: number) => number, copy: boolean) {
    const refs = [...this.sel].map(parseRef);
    this.sel = new Set(refs.map((r) => refKey(r.bone, Math.max(0, Math.round(to(r.f))))));
    runMove(refs, to, copy);
  }

  private graphDown(x: number, y: number, H: number, c: Clip) {
    if (x < NAME_W) {
      const i = Math.floor((y - RULER) / ROW);
      const ch = CHANNELS[i];
      if (ch) {
        if (this.visible.has(ch.id)) this.visible.delete(ch.id); else this.visible.add(ch.id);
        this.gRange = null;
        this.draw();
      }
      return;
    }
    const bone = this.graphBone();
    const t = bone !== null ? c.tracks[bone] : undefined;
    if (!t) return;
    this.ensureRange(t, c);
    if (this.gSel) {
      const hp = this.handlePositions(t, this.gSel.ch, c, this.gSel.f, H);
      if (hp) {
        for (const [which, p] of [[0, hp.h0], [1, hp.h1]] as const) {
          if (Math.abs(p.x - x) < 7 && Math.abs(p.y - y) < 7) { this.drag = { type: 'ghandle', ch: this.gSel.ch, which, f: this.gSel.f, moved: false }; return; }
        }
      }
    }
    const step = this.sampleStep(c);
    for (const ch of CHANNELS) {
      if (!this.visible.has(ch.id) || !t[ch.list].length) continue;
      const { values } = this.series(t, ch, c, step);
      for (const k of t[ch.list] as Key<unknown>[]) {
        const v = this.keyValue(t, ch, c, k.f, step, values);
        if (Math.hypot(this.xOf(k.f) - x, this.yOf(v, H) - y) < 7) {
          this.gSel = { ch, f: k.f };
          this.sel = new Set([refKey(bone!, k.f)]);
          this.drag = { type: 'gkey', ch, x0: x, y0: y, f0: k.f, v0: v, moved: false };
          this.draw();
          return;
        }
      }
    }
    this.gSel = null;
    this.sel.clear();
    this.draw();
  }

  private graphMoveKey(d: Extract<Drag, { type: 'gkey' }>, x: number, y: number, H: number, c: Clip, e: PointerEvent) {
    if (!d.moved) {
      if (Math.hypot(x - d.x0, y - d.y0) < 3) return;
      d.moved = true;
      ed.begin('Edit curve');
    }
    const bone = this.graphBone()!;
    const t = ed.clip()?.tracks[bone];
    if (!t) return;
    // Mostly-vertical drags change the value, mostly-horizontal ones the timing; Shift allows both.
    const dx = x - d.x0, dy = y - d.y0;
    const doTime = e.shiftKey || Math.abs(dx) > Math.abs(dy);
    const doValue = e.shiftKey || !doTime;
    const list = t[d.ch.list] as Key<unknown>[];
    const key = list.find((k) => k.f === (this.gSel?.f ?? d.f0));
    if (!key) return;
    if (doValue) {
      const r = this.gRange!;
      const pxPerUnit = (H - RULER - 20) / (r.hi - r.lo);
      this.setGraphValue(t, d.ch, key.f, d.v0 - dy / pxPerUnit);
    }
    if (doTime) {
      const nf = Math.max(0, Math.min(c.length, d.f0 + Math.round(dx / this.ppf)));
      if (nf !== key.f && !list.some((k) => k !== key && k.f === nf)) {
        key.f = nf;
        list.sort((a, b) => a.f - b.f);
        this.gSel = { ch: d.ch, f: nf };
        this.sel = new Set([refKey(bone, nf)]);
      }
    }
    ed.emit('anim', 'geometry');
    status(`${d.ch.label}  ${this.gSel ? `frame ${this.gSel.f}` : ''}   (Shift: value and time together)`);
  }

  private graphMoveHandle(d: Extract<Drag, { type: 'ghandle' }>, x: number, y: number, H: number, c: Clip) {
    if (!d.moved) { d.moved = true; ed.begin('Edit curve'); }
    const t = ed.clip()?.tracks[this.graphBone()!];
    if (!t) return;
    const hp = this.handlePositions(t, d.ch, c, d.f, H);
    if (!hp) return;
    const a = hp.a;
    const cur = a.c ? [...a.c] as [number, number, number, number] : [1 / 3, 1 / 3, 2 / 3, 2 / 3] as [number, number, number, number];
    const nx = Math.max(0, Math.min(1, ((x - NAME_W - 8) / this.ppf + this.start - a.f) / hp.dt));
    const ny = Math.max(-1, Math.min(2, (this.valueAt(y, H) - hp.v0) / hp.dv));
    if (d.which === 0) { cur[0] = nx; cur[1] = ny; } else { cur[2] = nx; cur[3] = ny; }
    a.c = cur;
    delete a.step;
    ed.emit('anim', 'geometry');
    status(`Curve at frame ${d.f}: ${easeSample(a)}`);
  }

  private onKey(e: KeyboardEvent) {
    const key = e.key.toLowerCase();
    let handled = true;
    if (e.ctrlKey && key === 'c') runCommand('anim.copyKeys');
    else if (e.ctrlKey && key === 'v') runCommand('anim.pasteKeys');
    else if (e.ctrlKey && key === 'a') this.selectAll();
    else if (e.ctrlKey || e.altKey) handled = false;
    else if (key === 'delete' || key === 'backspace') runCommand('anim.deleteSelected');
    else if (key === 'a' || key === 'home' || key === 'f') this.frameAll();
    else if (key === ' ') runCommand('anim.play');
    else if (key === 'escape') { if (this.sel.size) this.clearSelection(); else handled = false; }
    else if (key === 'tab') this.setView(this.view === 'dope' ? 'graph' : 'dope');
    else if (key === 'i') setRangeEnd('in', ed.frame);
    else if (key === 'o') setRangeEnd('out', ed.frame);
    else if (key === 'e') addEvent(ed.frame);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  selectAll() {
    const c = ed.clip();
    if (!c) return;
    this.sel.clear();
    for (const id of Object.keys(c.tracks).map(Number)) keyFrames(c, id).forEach((f) => this.sel.add(refKey(id, f)));
    this.draw();
  }

  get hasMouse() { return this.mouseInside; }
}

/** Apply a move or stretch to the active clip as one undo step. */
function runMove(refs: KeyRef[], to: (f: number) => number, copy: boolean) {
  const id = ed.activeClip;
  ed.transact(copy ? 'Copy keys' : 'Move keys', (m) => { const c = m.clips.find((x) => x.id === id); if (c) remapKeys(c, refs, to, copy); });
}

function easeSample(k: Key<unknown>) {
  const mid = easeT(k, 0.5);
  return mid > 0.6 ? 'fast start' : mid < 0.4 ? 'slow start' : 'even';
}

function niceStep(ppf: number) {
  for (const s of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 50000]) if (s * ppf >= 46) return s;
  return 100000;
}

function niceValueStep(raw: number) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  for (const k of [1, 2, 5, 10]) if (k * p >= raw) return k * p;
  return 10 * p;
}

function fmtValue(v: number, step: number) {
  return step >= 1 ? String(Math.round(v)) : v.toFixed(step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3);
}
