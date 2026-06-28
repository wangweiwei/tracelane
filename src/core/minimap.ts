/**
 * 缩略图子系统:自管离屏缓存。spans 层只在 markDirty 后重建一次(O(N)),
 * 平时每帧仅把缓存 blit 回来 + 画视口框(O(1)),所以 hover/平移不会重画百万 span。
 */
import type { TraceNode, TracelaneTheme } from '../types';
import { clamp } from '../utils';

/** span 数超过此值时缩略图改用「像素格聚合」绘制(此规模个体 span 已重叠不可辨,逐个画纯浪费) */
const BUCKET_THRESHOLD = 50_000;

/** 每帧渲染缩略图所需的数据(由 Tracelane 提供) */
export interface MinimapFrame {
  allSpans: TraceNode[];
  /** 与 allSpans 对齐的 DFS 序号数组;有则免去逐 span 的 orderIdx.get(过滤态为 null,回退 Map) */
  order: number[] | null;
  orderIdx: Map<string, number>;
  totalCount: number;
  /** 已加载数据的时间范围(亮区 = 已加载;域内其余为暗色肩部) */
  extent: [number, number];
  /** x 轴映射的时间域:无 totalDomain 时 = extent;有则为总域(已并入 extent) */
  domain: [number, number];
  v0: number;
  v1: number;
  colorFor: (node: TraceNode) => string;
}

export class Minimap {
  private buffer: HTMLCanvasElement | null = null;
  private bufferCtx: CanvasRenderingContext2D | null = null;
  private dirty = true;
  /** 上次重建缓存所用的域;域变化(如 totalDomain 增长)即重建,避免 x 位置过期 */
  private lastDomain: [number, number] | null = null;

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
    const domainChanged =
      !this.lastDomain || this.lastDomain[0] !== f.domain[0] || this.lastDomain[1] !== f.domain[1];
    if (this.dirty || domainChanged || !this.buffer) this.rebuild(f, mw, mh);
    // 贴回缓存的 spans 层:临时切到设备像素 1:1,绕过 ctx 的 dpr 变换避免二次缩放
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.buffer) this.ctx.drawImage(this.buffer, 0, 0);
    this.ctx.restore();
    // 视口框是唯一每帧的工作(CSS px,走 ctx 现有 dpr 变换);映射用 domain
    const [d0, d1] = f.domain;
    const range = Math.max(d1 - d0, 1);
    const r0 = clamp(((f.v0 - d0) / range) * mw, 0, mw);
    const r1 = clamp(((f.v1 - d0) / range) * mw, 0, mw);
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
    const [d0, d1] = f.domain;
    const range = Math.max(d1 - d0, 1);
    // 暗色肩部:总域里「已加载 extent」之外的两侧 = 还没拉的历史/未来,淡淡示意「还有更多」
    const [e0, e1] = f.extent;
    if (e0 > d0 || e1 < d1) {
      bctx.fillStyle = this.theme.grid;
      const lx = ((e0 - d0) / range) * mw;
      if (lx > 0.5) bctx.fillRect(0, 0, lx, mh);
      const rx = ((e1 - d0) / range) * mw;
      if (rx < mw - 0.5) bctx.fillRect(rx, 0, mw - rx, mh);
    }
    const spans = f.allSpans;
    const order = f.order;
    const idxOf = (i: number, n: TraceNode): number => (order ? order[i] : f.orderIdx.get(n.id) ?? 0);
    if (spans.length > BUCKET_THRESHOLD) {
      // 超大数据:按 (x 像素列 × y 行) 聚合,每个被占格只画一次(首色为准),
      // fillRect 从 O(spans) 降到 ≤ 列×行(画布像素级,几十万~百万 span 时绝大多数 span 本就重叠)。
      const cols = Math.max(1, Math.ceil(mw));
      const yRows = Math.max(1, Math.floor((mh - 8) / 3));
      const cell: (string | undefined)[] = new Array(cols * yRows);
      for (let i = 0; i < spans.length; i += 1) {
        const n = spans[i];
        let col = Math.floor(((n.start - d0) / range) * mw);
        col = col < 0 ? 0 : col >= cols ? cols - 1 : col;
        let yr = Math.floor((idxOf(i, n) / f.totalCount) * yRows);
        yr = yr < 0 ? 0 : yr >= yRows ? yRows - 1 : yr;
        const k = yr * cols + col;
        if (cell[k] === undefined) cell[k] = f.colorFor(n);
      }
      for (let k = 0; k < cell.length; k += 1) {
        const color = cell[k];
        if (color === undefined) continue;
        const col = k % cols;
        const yr = (k - col) / cols;
        bctx.fillStyle = color;
        bctx.fillRect(col, 3 + yr * 3, 1.5, 3);
      }
    } else {
      // 常规规模:逐 span 保真(显示色块时长宽度)
      for (let i = 0; i < spans.length; i += 1) {
        const n = spans[i];
        const x0 = ((n.start - d0) / range) * mw;
        const w = Math.max(1.5, (n.duration / range) * mw);
        const y = 3 + (idxOf(i, n) / f.totalCount) * (mh - 8);
        bctx.fillStyle = f.colorFor(n);
        bctx.fillRect(x0, y, w, 3);
      }
    }
    this.lastDomain = [d0, d1];
    this.dirty = false;
  }
}
