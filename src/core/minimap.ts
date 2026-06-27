/**
 * 缩略图子系统:自管离屏缓存。spans 层只在 markDirty 后重建一次(O(N)),
 * 平时每帧仅把缓存 blit 回来 + 画视口框(O(1)),所以 hover/平移不会重画百万 span。
 */
import type { TraceNode, TracelaneTheme } from '../types';
import { clamp } from '../utils';

/** 每帧渲染缩略图所需的数据(由 Tracelane 提供) */
export interface MinimapFrame {
  allSpans: TraceNode[];
  orderIdx: Map<string, number>;
  totalCount: number;
  extent: [number, number];
  v0: number;
  v1: number;
  colorFor: (node: TraceNode) => string;
}

export class Minimap {
  private buffer: HTMLCanvasElement | null = null;
  private bufferCtx: CanvasRenderingContext2D | null = null;
  private dirty = true;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ctx: CanvasRenderingContext2D,
    private theme: TracelaneTheme,
    private readonly height: number
  ) {}

  /** data/extent/orderIdx 变化时使缓存作废 */
  markDirty(): void {
    this.dirty = true;
  }

  /** 切换主题(视口框配色随之变;spans 缓存与主题无关,无需重建) */
  setTheme(theme: TracelaneTheme): void {
    this.theme = theme;
  }

  /** DPR/宽度变化时重设画布尺寸与变换,并使缓存作废 */
  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dirty = true;
  }

  draw(f: MinimapFrame): void {
    const mw = this.canvas.clientWidth;
    const mh = this.height;
    if (this.dirty || !this.buffer) this.rebuild(f, mw, mh);
    // 贴回缓存的 spans 层:临时切到设备像素 1:1,绕过 ctx 的 dpr 变换避免二次缩放
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.buffer) this.ctx.drawImage(this.buffer, 0, 0);
    this.ctx.restore();
    // 视口框是唯一每帧的工作(CSS px,走 ctx 现有 dpr 变换)
    const [e0, e1] = f.extent;
    const range = Math.max(e1 - e0, 1);
    const r0 = clamp(((f.v0 - e0) / range) * mw, 0, mw);
    const r1 = clamp(((f.v1 - e0) / range) * mw, 0, mw);
    this.ctx.fillStyle = this.theme.minimapViewportFill;
    this.ctx.fillRect(r0, 0, r1 - r0, mh);
    this.ctx.strokeStyle = this.theme.minimapViewportStroke;
    this.ctx.strokeRect(r0 + 0.5, 0.5, r1 - r0 - 1, mh - 1);
  }

  private rebuild(f: MinimapFrame, mw: number, mh: number): void {
    const dpr = window.devicePixelRatio || 1;
    let buf = this.buffer;
    if (!buf) {
      buf = document.createElement('canvas');
      this.buffer = buf;
      this.bufferCtx = buf.getContext('2d');
    }
    const bctx = this.bufferCtx;
    if (!bctx) return;
    const dw = Math.round(mw * dpr);
    const dh = Math.round(mh * dpr);
    if (buf.width !== dw || buf.height !== dh) {
      buf.width = dw;
      buf.height = dh;
    }
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.clearRect(0, 0, mw, mh);
    const [e0, e1] = f.extent;
    const range = Math.max(e1 - e0, 1);
    for (const n of f.allSpans) {
      const x0 = ((n.start - e0) / range) * mw;
      const w = Math.max(1.5, (n.duration / range) * mw);
      const idx = f.orderIdx.get(n.id) ?? 0;
      const y = 3 + (idx / f.totalCount) * (mh - 8);
      bctx.fillStyle = f.colorFor(n);
      bctx.fillRect(x0, y, w, 3);
    }
    this.dirty = false;
  }
}
