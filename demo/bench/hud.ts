/**
 * tracelane · demo · bench
 * ------------------------------------------------------------------
 * Self-contained performance HUD overlay. Zero dependencies, pure DOM.
 * Imports nothing from src/. Pins a small monospace readout to the
 * top-right corner showing live FPS / frame timing plus custom metrics.
 *
 *   const hud = attachHud();
 *   hud.set('spans', 1_000_000);
 *   const end = hud.beginFrame(); ...render...; end();   // → "render ms"
 *   hud.mark('minimap rebuild', 4.2);
 *   hud.destroy();
 * ------------------------------------------------------------------
 */

export interface Hud {
  /** record a one-shot timing for a named operation (e.g. minimap rebuild) */
  mark(label: string, ms: number): void;
  /** set a named scalar readout (e.g. spans, mem MB, dpr, rects) */
  set(label: string, value: string | number): void;
  /** call at the start of a frame you want timed; returns a fn to call at end */
  beginFrame(): () => void;
  destroy(): void;
}

const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

/** Thousand-separate integers; leave non-integer numbers and strings as-is. */
function fmt(value: string | number): string {
  if (typeof value === 'string') return value;
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function attachHud(parent?: HTMLElement): Hud {
  const host = parent ?? document.body;

  const root = document.createElement('div');
  Object.assign(root.style, {
    position: 'fixed',
    top: '8px',
    right: '8px',
    zIndex: '2147483647',
    pointerEvents: 'none',
    font: '11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    color: '#e8e8e8',
    background: 'rgba(12, 14, 18, 0.78)',
    padding: '6px 8px',
    borderRadius: '6px',
    boxShadow: '0 1px 6px rgba(0,0,0,0.35)',
    minWidth: '150px',
    whiteSpace: 'pre',
    userSelect: 'none'
  } as Partial<CSSStyleDeclaration>);

  // One <div> row per label; each holds a label span and a right-aligned value.
  const rows = new Map<string, { row: HTMLDivElement; val: HTMLSpanElement }>();

  function rowFor(label: string): HTMLSpanElement {
    let entry = rows.get(label);
    if (!entry) {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex',
        justifyContent: 'space-between',
        gap: '12px'
      } as Partial<CSSStyleDeclaration>);
      const key = document.createElement('span');
      key.textContent = label;
      key.style.color = '#9aa4b2';
      const val = document.createElement('span');
      val.style.color = '#6fe06f';
      val.style.fontVariantNumeric = 'tabular-nums';
      val.style.textAlign = 'right';
      row.appendChild(key);
      row.appendChild(val);
      root.appendChild(row);
      entry = { row, val };
      rows.set(label, entry);
    }
    return entry.val;
  }

  host.appendChild(root);

  // --- frame-timing state -------------------------------------------------
  let emaMs = 16.7; // exponential moving average of frame delta
  const window1s: Array<{ t: number; ms: number }> = []; // last ~1s of deltas
  let last = now();
  let raf = 0;

  function tick(): void {
    const t = now();
    const delta = t - last;
    last = t;

    emaMs += (delta - emaMs) * 0.1;

    window1s.push({ t, ms: delta });
    const cutoff = t - 1000;
    while (window1s.length && window1s[0]!.t < cutoff) window1s.shift();
    let worst = 0;
    for (const s of window1s) if (s.ms > worst) worst = s.ms;

    const fps = emaMs > 0 ? 1000 / emaMs : 0;
    rowFor('fps').textContent = fps.toFixed(0);
    rowFor('ms/frame').textContent = emaMs.toFixed(1);
    rowFor('worst 1s').textContent = worst.toFixed(1) + ' ms';

    raf = requestAnimationFrame(tick);
  }
  raf = requestAnimationFrame(tick);

  return {
    set(label: string, value: string | number): void {
      rowFor(label).textContent = fmt(value);
    },
    mark(label: string, ms: number): void {
      rowFor(label).textContent = ms.toFixed(1) + ' ms';
    },
    beginFrame(): () => void {
      const start = now();
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        rowFor('render').textContent = (now() - start).toFixed(1) + ' ms';
      };
    },
    destroy(): void {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      window1s.length = 0;
      rows.clear();
      root.remove();
    }
  };
}
