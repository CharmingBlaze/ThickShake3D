// The gradient bar: drag stops to move them, click the bar to add one, and click a stop to choose its colour.
import { gradientCss, sampleGradient } from '../core/materials';
import type { Gradient, GradientStop } from '../core/types';
import { h } from './dom';

export interface GradientBarCallbacks {
  /** Which stop is selected, by position in the list. */
  selected: number;
  onSelect(index: number): void;
  /** A stop is being dragged. Live, so the model can follow. */
  onDragStart(): void;
  onDrag(stops: GradientStop[], selected: number): void;
  onDragEnd(stops: GradientStop[], selected: number): void;
  /** A stop was added by clicking the bar. */
  onAdd(stops: GradientStop[], selected: number): void;
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));

export function gradientBar(g: Gradient, cb: GradientBarCallbacks): HTMLElement {
  const fill = h('div', { class: 'grad-fill', style: { background: gradientCss(g) } });
  const bar = h('div', { class: 'grad-bar', title: 'Click to add a colour. Drag a marker to move it.' }, fill);

  const posIn = (r: DOMRect, e: PointerEvent) => clamp((e.clientX - r.left) / Math.max(1, r.width));

  g.stops.forEach((s, i) => {
    const handle = h('button', {
      class: `grad-stop${i === cb.selected ? ' active' : ''}`, style: { left: `${s.at * 100}%`, background: s.color },
      title: `${s.color} at ${Math.round(s.at * 100)}%. Click to select, drag to move.`, 'aria-label': `Colour stop ${i + 1} of ${g.stops.length}`, 'data-stop': String(i),
    });
    handle.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      cb.onSelect(i);
      let moved = false;
      let stops = g.stops.map((x) => ({ ...x }));
      const x0 = e.clientX;
      // Measured now: the panel redraws during the drag, which takes this bar off the page.
      const rect = fill.getBoundingClientRect();
      const move = (ev: PointerEvent) => {
        if (!moved && Math.abs(ev.clientX - x0) < 3) return;
        if (!moved) { moved = true; cb.onDragStart(); }
        stops = stops.map((x, n) => (n === i ? { ...x, at: posIn(rect, ev) } : x));
        // The list stays in its order while dragging, so the same stop stays selected even past a neighbour.
        cb.onDrag(stops, i);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        if (moved) cb.onDragEnd(stops, i);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
    bar.appendChild(handle);
  });

  fill.addEventListener('pointerdown', (e: PointerEvent) => {
    e.preventDefault();
    const at = posIn(fill.getBoundingClientRect(), e);
    const color = sampleGradient(g, at);
    const stops = [...g.stops.map((x) => ({ ...x })), { at, color }];
    cb.onAdd(stops, stops.length - 1);
  });
  return bar;
}
