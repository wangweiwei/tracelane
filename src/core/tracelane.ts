import type {
  BarShape,
  CategoryStyle,
  NodeStatus,
  ThemeInput,
  TraceNode,
  TracelaneOptions,
  TracelaneTheme
} from '../types';
import { paletteColor, resolveTheme } from '../theme';
import { clamp, formatTimeDefault, niceStep, roundRect, truncate } from '../utils';
import { type Row, collectVisibleSpans, deriveExtent, flattenRows, indexTree, isExpandable } from './tree';
import { defaultTooltip } from './tooltip';
import { Minimap } from './minimap';

interface DragState {
  x: number;
  y: number;
  v0: number;
  v1: number;
  scrollY: number;
  moved: number;
}

const AXIS_H = 22;
const MIN_WINDOW_MS = 20;
const FALLBACK_CATEGORY: CategoryStyle = { label: '未知类别', color: '#888888' };

/**
 * Tracelane 全链路行为时间线。
 * 因果树瀑布布局:每个行为独占一行,纵向虚拟滚动,横向时间缩放平移,
 * 折叠组(GroupNode)与因果链(children)统一为"可展开的行"。
 */
export class Tracelane {
  private readonly container: HTMLElement;
  private readonly wrapper: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tooltipEl: HTMLDivElement;
  private readonly minimapCanvas: HTMLCanvasElement | null = null;
  private minimap: Minimap | null = null;

  private readonly categories: Record<string, CategoryStyle>;
  private theme: TracelaneTheme;
  private readonly rowHeight: number;
  private readonly labelWidth: number;
  private readonly height: number;
  private readonly minimapHeight: number;
  private readonly fmt: (ms: number) => string;
  private readonly tooltipRenderer: false | ((node: TraceNode, expanded: boolean) => string);
  private readonly colorOf?: (node: TraceNode) => string | undefined;
  private readonly labelOf?: (node: TraceNode) => string;
  private readonly shapeOf?: (node: TraceNode) => BarShape;
  private readonly statusOf?: (node: TraceNode) => NodeStatus | undefined;
  private readonly onSelect?: (node: TraceNode | null) => void;
  private readonly onExpandChange?: (ids: string[]) => void;
  private readonly onViewChange?: (view: [number, number]) => void;
  private readonly onReachEdge?: (edge: 'start' | 'end', view: [number, number]) => void;

  private data: TraceNode[] = [];
  private extentFromOptions: [number, number] | undefined;
  private extent: [number, number] = [0, 1000];
  private v0 = 0;
  private v1 = 1000;
  private scrollY = 0;

  private expanded = new Set<string>();
  private rows: Row[] = [];
  private byId = new Map<string, TraceNode>();
  private parents = new Map<string, string>();
  private allSpans: TraceNode[] = [];
  private orderIdx = new Map<string, number>();
  private totalCount = 0;
  /** 被类别过滤隐藏的类别 key;隐藏其 span 连同因果子树。空=全显示 */
  private hiddenCategories = new Set<string>();
  /** allSpans 去掉「被隐藏类别及其子树」后的结果,供缩略图过滤渲染 */
  private filteredSpans: TraceNode[] = [];

  private width = 0;
  private hoverNode: TraceNode | null = null;
  private hoverRow = -1;
  private selected: TraceNode | null = null;
  private drag: DragState | null = null;
  private minimapDragging = false;
  private destroyed = false;
  /** 待执行的渲染帧句柄;非 null 表示已排队,用于把一帧内多次触发合并成一次 */
  private rafId: number | null = null;
  /** 截断后标签缓存:键 `${node.id}|${预算}` → 截断串;避免每帧逐行 measureText。setData 失效 */
  private labelCache = new Map<string, string>();
  /** 当前已停靠并已触发过 onReachEdge 的边缘;用于去抖(离开边缘 / setData 后重置) */
  private reachedEdge: 'start' | 'end' | null = null;
  /** 点击「加载更多」图标后置位;下次 appendData/setData 并入数据时把视口滑到新段 */
  private pendingPanToEnd = false;
  /** 加载更多进行中:驱动刷新图标旋转(独立 rAF 循环),setData 并入数据时停 */
  private loadingMore = false;
  private spinRaf: number | null = null;
  private spinStart = 0;
  private spinTimeout: number | null = null;

  private readonly ro: ResizeObserver;
  private readonly onWindowMouseMove = (e: MouseEvent) => this.handleWindowMouseMove(e);
  private readonly onWindowMouseUp = (e: MouseEvent) => this.handleWindowMouseUp(e);

  constructor(container: HTMLElement, options: TracelaneOptions) {
    this.container = container;
    this.categories = options.categories ?? {};
    this.theme = resolveTheme(options.theme);
    this.rowHeight = options.rowHeight ?? 26;
    this.labelWidth = options.labelWidth ?? 170;
    this.height = options.height ?? 300;
    this.minimapHeight = options.minimapHeight ?? 46;
    this.fmt = options.formatTime ?? formatTimeDefault;
    this.tooltipRenderer =
      options.tooltip === false
        ? false
        : options.tooltip ??
          ((n, ex) =>
            defaultTooltip(n, ex, {
              categoryOf: (x) => this.categoryOf(x),
              theme: this.theme,
              fmt: this.fmt
            }));
    this.colorOf = options.colorOf;
    this.labelOf = options.labelOf;
    this.shapeOf = options.shapeOf;
    this.statusOf = options.statusOf;
    this.onSelect = options.onSelect;
    this.onExpandChange = options.onExpandChange;
    this.onViewChange = options.onViewChange;
    this.onReachEdge = options.onReachEdge;
    this.extentFromOptions = options.timeExtent;

    // ---- DOM ----
    this.wrapper = document.createElement('div');
    this.wrapper.style.position = 'relative';
    this.wrapper.style.width = '100%';

    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = `${this.height}px`;
    this.canvas.style.cursor = 'grab';
    this.canvas.style.touchAction = 'none';
    this.wrapper.appendChild(this.canvas);

    this.tooltipEl = document.createElement('div');
    Object.assign(this.tooltipEl.style, {
      position: 'absolute',
      display: 'none',
      pointerEvents: 'none',
      zIndex: '10',
      maxWidth: '280px',
      padding: '8px 10px',
      borderRadius: '8px',
      fontSize: '12px',
      lineHeight: '1.5',
      background: this.theme.tooltipBg,
      border: `1px solid ${this.theme.tooltipBorder}`,
      boxShadow: this.theme.tooltipShadow,
      color: this.theme.text,
      fontFamily: this.theme.fontFamily
    } satisfies Partial<CSSStyleDeclaration>);
    this.wrapper.appendChild(this.tooltipEl);

    if (options.minimap !== false) {
      this.minimapCanvas = document.createElement('canvas');
      this.minimapCanvas.style.display = 'block';
      this.minimapCanvas.style.width = '100%';
      this.minimapCanvas.style.height = `${this.minimapHeight}px`;
      this.minimapCanvas.style.marginTop = '6px';
      this.minimapCanvas.style.cursor = 'pointer';
      this.wrapper.appendChild(this.minimapCanvas);
      const mctx = this.minimapCanvas.getContext('2d');
      if (mctx) this.minimap = new Minimap(this.minimapCanvas, mctx, this.theme, this.minimapHeight);
    }

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('[tracelane] 无法创建 2D 渲染上下文');
    this.ctx = ctx;
    this.container.appendChild(this.wrapper);

    // ---- 事件 ----
    this.canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    this.canvas.addEventListener('mousedown', this.handleMouseDown);
    this.canvas.addEventListener('mousemove', this.handleMouseMove);
    this.canvas.addEventListener('mouseleave', this.handleMouseLeave);
    this.minimapCanvas?.addEventListener('mousedown', this.handleMinimapMouseDown);
    window.addEventListener('mousemove', this.onWindowMouseMove);
    window.addEventListener('mouseup', this.onWindowMouseUp);

    this.ro = new ResizeObserver(() => this.syncSize());
    this.ro.observe(this.wrapper);

    // ---- 数据与初始状态 ----
    options.defaultExpandedIds?.forEach((id) => this.expanded.add(id));
    this.setData(options.data, { keepView: false, silent: true });
    if (options.initialView) {
      this.v0 = options.initialView[0];
      this.v1 = options.initialView[1];
      this.clampView();
    }
    this.syncSize();
  }

  // ================= 公开 API =================

  /** 替换数据。keepView 为 true 时保留当前时间视口与滚动位置 */
  setData(data: TraceNode[], opts: { keepView?: boolean; silent?: boolean } = {}): void {
    const prevEnd = this.extent[1]; // 用于点击加载后滑到新数据
    this.data = data;
    this.indexData();
    this.extent = this.extentFromOptions ?? deriveExtent(this.byId);
    this.minimap?.markDirty(); // 数据/extent/orderIdx 变了,缩略图缓存作废
    this.labelCache.clear(); // 数据变了,截断标签缓存作废
    this.reachedEdge = null; // extent 变了(可能追加了数据),重新武装边缘回调
    this.clearSpin(); // 数据已并入,停止刷新动画(下面会重绘静止态)
    const valid = new Set([...this.expanded].filter((id) => this.byId.has(id)));
    this.expanded = valid;
    if (this.selected && !this.byId.has(this.selected.id)) this.selected = null;
    this.flatten();
    if (!opts.keepView) {
      this.v0 = this.extent[0];
      this.v1 = this.extent[1];
      this.scrollY = 0;
    } else if (this.pendingPanToEnd && this.extent[1] > prevEnd) {
      // 点击「加载更多」后:把视口推进到原末端附近,露出新追加的那段
      const span = this.v1 - this.v0;
      this.v0 = prevEnd - span * 0.15;
      this.v1 = this.v0 + span;
    }
    this.pendingPanToEnd = false;
    this.clampView();
    this.clampScroll();
    if (!opts.silent) this.draw();
  }

  /**
   * 增量追加顶层节点(配合 onReachEdge「滑动加载更多」用):并入现有数据、按 start
   * 重排、保留当前视口。注意 nodes 的 start 必须与现有数据同一时间坐标(同 origin),
   * 否则会错位——增量加载时请用固定 origin,而非每批 'auto'。
   */
  appendData(nodes: TraceNode[]): void {
    if (nodes.length === 0) return;
    const merged = [...this.data, ...nodes].sort((a, b) => a.start - b.start);
    this.setData(merged, { keepView: true });
  }

  /** 运行时切换主题(亮/暗/覆盖对象);数据、视口、展开、选中等状态全部保留 */
  setTheme(theme: ThemeInput): void {
    this.theme = resolveTheme(theme);
    Object.assign(this.tooltipEl.style, {
      background: this.theme.tooltipBg,
      border: `1px solid ${this.theme.tooltipBorder}`,
      boxShadow: this.theme.tooltipShadow,
      color: this.theme.text,
      fontFamily: this.theme.fontFamily
    } satisfies Partial<CSSStyleDeclaration>);
    this.minimap?.setTheme(this.theme);
    this.draw();
  }

  getView(): [number, number] {
    return [this.v0, this.v1];
  }

  zoomTo(t0: number, t1: number): void {
    this.v0 = Math.min(t0, t1);
    this.v1 = Math.max(t0, t1);
    this.clampView();
    this.draw();
    this.emitView();
  }

  zoomIn(): void {
    this.zoomAt(0.7);
  }

  zoomOut(): void {
    this.zoomAt(1 / 0.7);
  }

  resetView(): void {
    this.v0 = this.extent[0];
    this.v1 = this.extent[1];
    this.scrollY = 0;
    this.clampView();
    this.draw();
    this.emitView();
  }

  getExpanded(): string[] {
    return [...this.expanded];
  }

  setExpanded(ids: string[]): void {
    this.expanded = new Set(ids.filter((id) => this.byId.has(id)));
    this.flatten();
    this.clampScroll();
    this.draw();
    this.onExpandChange?.(this.getExpanded());
  }

  expand(id: string): void {
    if (!this.byId.has(id) || this.expanded.has(id)) return;
    this.expanded.add(id);
    this.flatten();
    this.draw();
    this.onExpandChange?.(this.getExpanded());
  }

  collapse(id: string): void {
    if (!this.expanded.delete(id)) return;
    this.flatten();
    this.clampScroll();
    this.draw();
    this.onExpandChange?.(this.getExpanded());
  }

  collapseAll(): void {
    if (this.expanded.size === 0) return;
    this.expanded.clear();
    this.flatten();
    this.clampScroll();
    this.draw();
    this.onExpandChange?.(this.getExpanded());
  }

  /** 当前被隐藏的类别 key 列表 */
  getHiddenCategories(): string[] {
    return [...this.hiddenCategories];
  }

  /**
   * 按类别过滤:隐藏给定类别的 span 连同其因果子树(传空数组=全部显示)。
   * 缩略图同步过滤;若当前选中行落入被隐藏的支,取消选中并触发 onSelect(null)。
   */
  setHiddenCategories(keys: string[]): void {
    this.hiddenCategories = new Set(keys);
    this.refreshFilteredSpans();
    if (this.selected && this.isHiddenByFilter(this.selected)) {
      this.selected = null;
      this.onSelect?.(null);
    }
    this.flatten();
    this.clampScroll();
    this.minimap?.markDirty();
    this.draw();
  }

  /** 选中节点(null 取消选中),会触发 onSelect */
  select(id: string | null): void {
    this.selected = id ? this.byId.get(id) ?? null : null;
    this.draw();
    this.onSelect?.(this.selected);
  }

  /** 若节点色块中点落在当前时间视口外,平移视口将其居中(点击选中与 reveal 共用) */
  private panToNodeTime(node: TraceNode): void {
    const mid = node.start + node.duration / 2;
    if (mid < this.v0 || mid > this.v1) {
      const span = this.v1 - this.v0;
      this.v0 = mid - span / 2;
      this.v1 = mid + span / 2;
      this.clampView();
      this.emitView();
    }
  }

  /** 展开祖先、纵向滚动到该行并选中;若节点在时间视口外则平移视口将其居中 */
  reveal(id: string): void {
    const node = this.byId.get(id);
    if (!node) return;
    let cur = this.parents.get(id);
    let changed = false;
    while (cur) {
      if (!this.expanded.has(cur)) {
        this.expanded.add(cur);
        changed = true;
      }
      cur = this.parents.get(cur);
    }
    this.flatten();
    if (changed) this.onExpandChange?.(this.getExpanded());
    const idx = this.rows.findIndex((r) => r.node.id === id);
    if (idx >= 0) {
      const viewportH = this.height - AXIS_H;
      const target = idx * this.rowHeight - viewportH / 2 + this.rowHeight / 2;
      this.scrollY = target;
      this.clampScroll();
    }
    this.panToNodeTime(node);
    this.selected = node;
    this.draw();
    this.onSelect?.(node);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.clearSpin();
    this.ro.disconnect();
    this.canvas.removeEventListener('wheel', this.handleWheel);
    this.canvas.removeEventListener('mousedown', this.handleMouseDown);
    this.canvas.removeEventListener('mousemove', this.handleMouseMove);
    this.canvas.removeEventListener('mouseleave', this.handleMouseLeave);
    this.minimapCanvas?.removeEventListener('mousedown', this.handleMinimapMouseDown);
    window.removeEventListener('mousemove', this.onWindowMouseMove);
    window.removeEventListener('mouseup', this.onWindowMouseUp);
    this.wrapper.remove();
  }

  // ================= 索引与布局 =================

  private indexData(): void {
    const idx = indexTree(this.data);
    this.byId = idx.byId;
    this.parents = idx.parents;
    this.allSpans = idx.allSpans;
    this.orderIdx = idx.orderIdx;
    this.totalCount = idx.totalCount;
    this.refreshFilteredSpans();
  }

  private flatten(): void {
    this.rows = flattenRows(this.data, this.expanded, this.hiddenCategories);
  }

  /** allSpans 去掉「被隐藏类别及其子树」,供缩略图过滤;无过滤时直接复用 allSpans */
  private refreshFilteredSpans(): void {
    this.filteredSpans =
      this.hiddenCategories.size === 0
        ? this.allSpans
        : collectVisibleSpans(this.data, this.hiddenCategories);
  }

  /** 节点本身或任一祖先的类别被隐藏,则它落在被过滤掉的支里 */
  private isHiddenByFilter(node: TraceNode): boolean {
    if (this.hiddenCategories.size === 0) return false;
    let cur: TraceNode | undefined = node;
    while (cur) {
      if (this.hiddenCategories.has(cur.category)) return true;
      const pid = this.parents.get(cur.id);
      cur = pid ? this.byId.get(pid) : undefined;
    }
    return false;
  }

  private maxScroll(): number {
    return Math.max(0, this.rows.length * this.rowHeight - (this.height - AXIS_H));
  }

  private clampScroll(): void {
    this.scrollY = clamp(this.scrollY, 0, this.maxScroll());
  }

  private clampView(): void {
    const [e0, e1] = this.extent;
    const full = Math.max(e1 - e0, MIN_WINDOW_MS);
    // 视宽不超过全域;起点夹在 [e0, e1-span] 内 —— 不允许越界到数据之外的空白。
    // 越界会把 T+0 之前的空白标成负刻度,并把缩略图视口框推出边界裁掉。
    const span = clamp(this.v1 - this.v0, MIN_WINDOW_MS, full);
    const start = clamp(this.v0, e0, e1 - span);
    this.v0 = start;
    this.v1 = start + span;
  }

  /**
   * 边缘检测:入参 desiredV0 是 clampView 之前捕获的视口起点(本方法在 clampView 之后调用)。
   * 用户把视口推到数据起点/末端之外时触发一次 onReachEdge,去抖见 reachedEdge。
   */
  private maybeReachEdge(desiredV0: number, span: number): void {
    if (!this.onReachEdge) return;
    const [e0, e1] = this.extent;
    const eps = Math.max(span * 1e-4, 0.5);
    let edge: 'start' | 'end' | null = null;
    if (desiredV0 < e0 - eps) edge = 'start';
    else if (desiredV0 + span > e1 + eps) edge = 'end';
    if (edge === null) {
      this.reachedEdge = null; // 离开边缘,重新武装
    } else if (this.reachedEdge !== edge) {
      this.reachedEdge = edge;
      if (edge === 'end') this.startSpin(); // 拖动触发的加载也转图标,与点击统一
      this.onReachEdge(edge, [this.v0, this.v1]);
    }
  }

  private xOf(t: number): number {
    return this.labelWidth + ((t - this.v0) / (this.v1 - this.v0)) * (this.width - this.labelWidth);
  }

  private tOf(px: number): number {
    return this.v0 + ((px - this.labelWidth) / (this.width - this.labelWidth)) * (this.v1 - this.v0);
  }

  private categoryOf(node: TraceNode): CategoryStyle {
    const reg = this.categories[node.category];
    if (reg) return reg;
    if (!node.category) return FALLBACK_CATEGORY;
    // 未注册类别:稳定哈希取调色板色,文案用 key 自身
    return { label: node.category, color: paletteColor(node.category) };
  }

  /** 颜色编码:colorOf 优先,缺省退回类别色 */
  private colorFor(node: TraceNode): string {
    return this.colorOf?.(node) ?? this.categoryOf(node).color;
  }

  /** 几何形态:shapeOf 优先,缺省时 duration<=0 判为瞬时事件 */
  private shapeFor(node: TraceNode): BarShape {
    return this.shapeOf?.(node) ?? (node.duration <= 0 ? 'point' : 'bar');
  }

  /** 时间区命中范围(像素);point 用对称半宽,便于命中菱形 */
  private barHitRange(node: TraceNode): [number, number] {
    const x0 = this.xOf(node.start);
    if (this.shapeFor(node) === 'point') return [x0 - 7, x0 + 7];
    return [x0, Math.max(this.xOf(node.start + node.duration), x0 + 2)];
  }

  // ================= 渲染 =================

  private syncSize(): void {
    if (this.destroyed) return;
    this.width = this.canvas.clientWidth;
    if (this.width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.minimap?.resize();
    this.draw();
  }

  /**
   * 调度一次渲染:一帧内多次触发只渲染一次(rAF 合并)。
   * 注意:状态变更与回调(onSelect/onExpandChange/onViewChange)仍在调用方同步执行,
   * 这里只把"像素绘制"延后到下一帧,因此 getView()/getExpanded() 等同步语义不变。
   */
  private draw(): void {
    if (this.destroyed || this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.render();
    });
  }

  private render(): void {
    if (this.destroyed || this.width === 0) return;
    const { ctx, theme } = this;
    const W = this.width;
    const H = this.height;
    ctx.clearRect(0, 0, W, H);
    ctx.font = `11px ${theme.fontFamily}`;
    ctx.textBaseline = 'middle';

    // 时间轴刻度
    const step = niceStep((this.v1 - this.v0) / Math.max((W - this.labelWidth) / 85, 1));
    ctx.textAlign = 'center';
    for (let t = Math.ceil(this.v0 / step) * step; t <= this.v1; t += step) {
      const px = this.xOf(t);
      ctx.strokeStyle = theme.grid;
      ctx.beginPath();
      ctx.moveTo(px, AXIS_H);
      ctx.lineTo(px, H);
      ctx.stroke();
      ctx.fillStyle = theme.textTertiary;
      ctx.fillText(this.fmt(t), px, 10);
    }

    // 行(仅可视区间,虚拟渲染)
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, AXIS_H, W, H - AXIS_H);
    ctx.clip();
    const first = Math.max(0, Math.floor(this.scrollY / this.rowHeight));
    const last = Math.min(
      this.rows.length - 1,
      Math.ceil((this.scrollY + H - AXIS_H) / this.rowHeight)
    );
    for (let i = first; i <= last; i += 1) {
      this.drawRow(i);
    }
    ctx.restore();

    // 文字栏分隔线
    ctx.strokeStyle = theme.grid;
    ctx.beginPath();
    ctx.moveTo(this.labelWidth, 0);
    ctx.lineTo(this.labelWidth, H);
    ctx.stroke();

    // 纵向滚动指示条
    const ms = this.maxScroll();
    if (ms > 0) {
      const vh = H - AXIS_H;
      const barH = Math.max(24, (vh * vh) / (this.rows.length * this.rowHeight));
      const barY = AXIS_H + (vh - barH) * (this.scrollY / ms);
      ctx.fillStyle = theme.scrollbar;
      ctx.fillRect(W - 4, barY, 3, barH);
    }

    this.drawEdgeHints();

    this.minimap?.draw({
      allSpans: this.filteredSpans,
      orderIdx: this.orderIdx,
      totalCount: this.totalCount,
      extent: this.extent,
      v0: this.v0,
      v1: this.v1,
      colorFor: (n) => this.colorFor(n)
    });
  }

  /** 末端加载提示当前是否可见(开启 onReachEdge 且视口紧贴末端) */
  private endHintVisible(): boolean {
    if (!this.onReachEdge) return false;
    const eps = Math.max((this.v1 - this.v0) * 1e-4, 0.5);
    return this.extent[1] - this.v1 <= eps;
  }

  /** 提示图标中心(右缘,垂直居中) */
  private endHintCenter(): { cx: number; cy: number } {
    return { cx: this.width - 18, cy: AXIS_H + (this.height - AXIS_H) / 2 };
  }

  /** 点是否落在加载提示的可点区域(且提示可见) */
  private endHintHit(x: number, y: number): boolean {
    if (!this.endHintVisible()) return false;
    const { cx, cy } = this.endHintCenter();
    return Math.abs(x - cx) <= 12 && Math.abs(y - cy) <= 16;
  }

  /**
   * 滑动加载边缘提示:开启 onReachEdge 后,视口贴到数据**末端**时在右缘画一个刷新图标,
   * 提示这边还能拖出更多内容。判定与 maybeReachEdge('end') 对齐(紧贴边才显示);
   * 图标也可直接点击触发加载(见 handleWindowMouseUp)。只提示末端。
   */
  private drawEdgeHints(): void {
    if (!this.endHintVisible() && !this.loadingMore) return;
    const { ctx, theme } = this;
    const { cx, cy } = this.endHintCenter();
    const r = 6.5;
    ctx.save();
    ctx.translate(cx, cy);
    if (this.loadingMore) {
      // 加载中:按时间匀速旋转(~1.1 圈/秒)
      ctx.rotate(((performance.now() - this.spinStart) / 1000) * Math.PI * 2 * 1.1);
    }
    ctx.strokeStyle = theme.textSecondary;
    ctx.fillStyle = theme.textSecondary;
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const aHead = -Math.PI * 0.72; // 箭头端(约 10:30 方向)
    const aSolidEnd = Math.PI * 0.46; // 实线终点(约 5 点)
    // 实线主弧:从箭头端顺时针绕过 上→右→ 到底部右
    ctx.beginPath();
    ctx.arc(0, 0, r, aHead, aSolidEnd);
    ctx.stroke();
    // 底部圆点尾:点直径 = 线宽、等角间距 0.16π。实线圆头帽直径恰好 = 点直径,
    // 正好充当尾巴的第一个点,整条匀整;尾点止于 0.94π,留出空当不被箭头遮住。
    const dotR = ctx.lineWidth / 2;
    for (const a of [0.62, 0.78, 0.94]) {
      ctx.beginPath();
      ctx.arc(r * Math.cos(a * Math.PI), r * Math.sin(a * Math.PI), dotR, 0, Math.PI * 2);
      ctx.fill();
    }
    // 箭头:在箭头端沿切线逆向画三角,像收尾的箭头
    const hx = r * Math.cos(aHead);
    const hy = r * Math.sin(aHead);
    let fx = r * Math.cos(aHead + 0.05) - hx;
    let fy = r * Math.sin(aHead + 0.05) - hy;
    const fl = Math.hypot(fx, fy) || 1;
    fx /= fl;
    fy /= fl;
    const dx = -fx;
    const dy = -fy;
    const nx = -dy;
    const ny = dx;
    const ah = 4.6;
    ctx.beginPath();
    ctx.moveTo(hx + dx * ah, hy + dy * ah);
    ctx.lineTo(hx - dx * ah * 0.35 + nx * ah, hy - dy * ah * 0.35 + ny * ah);
    ctx.lineTo(hx - dx * ah * 0.35 - nx * ah, hy - dy * ah * 0.35 - ny * ah);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /** 进入加载态:启动旋转动画循环 + 安全超时(接入方迟迟不返回时自动停) */
  private startSpin(): void {
    if (this.loadingMore) return;
    this.loadingMore = true;
    this.spinStart = performance.now();
    const tick = (): void => {
      if (this.destroyed || !this.loadingMore) {
        this.spinRaf = null;
        return;
      }
      this.render();
      this.spinRaf = requestAnimationFrame(tick);
    };
    if (this.spinRaf === null) this.spinRaf = requestAnimationFrame(tick);
    if (this.spinTimeout !== null) clearTimeout(this.spinTimeout);
    this.spinTimeout = window.setTimeout(() => this.stopSpin(), 12000);
  }

  /** 清理旋转状态(不重绘) */
  private clearSpin(): void {
    this.loadingMore = false;
    if (this.spinRaf !== null) {
      cancelAnimationFrame(this.spinRaf);
      this.spinRaf = null;
    }
    if (this.spinTimeout !== null) {
      clearTimeout(this.spinTimeout);
      this.spinTimeout = null;
    }
  }

  /** 安全超时回调:停转并恢复静止 */
  private stopSpin(): void {
    if (!this.loadingMore) return;
    this.clearSpin();
    this.draw();
  }

  /**
   * 截断标签(带缓存)。字体恒定(11px),故同一 (id, 预算) 的截断结果稳定;
   * 假设 labelOf 为纯函数(与逐帧调用的现有约定一致),setData 时整表失效。
   */
  private truncatedLabel(
    ctx: CanvasRenderingContext2D,
    id: string,
    label: string,
    maxWidth: number
  ): string {
    const key = `${id}|${Math.round(maxWidth)}`;
    let cached = this.labelCache.get(key);
    if (cached === undefined) {
      cached = truncate(ctx, label, maxWidth);
      this.labelCache.set(key, cached);
    }
    return cached;
  }

  private drawRow(index: number): void {
    const { ctx, theme } = this;
    const row = this.rows[index];
    const node = row.node;
    const y = AXIS_H + index * this.rowHeight - this.scrollY;
    const color = this.colorFor(node);
    const isOpen = this.expanded.has(node.id);
    const hasChildren = isExpandable(node);

    if (index === this.hoverRow) {
      ctx.fillStyle = theme.rowHover;
      ctx.fillRect(0, y, this.width, this.rowHeight);
    }
    ctx.strokeStyle = theme.grid;
    ctx.beginPath();
    ctx.moveTo(0, y + this.rowHeight);
    ctx.lineTo(this.width, y + this.rowHeight);
    ctx.stroke();

    // 语义状态:行左缘 accent(error / warn)
    const status = this.statusOf?.(node);
    if (status === 'error' || status === 'warn') {
      ctx.fillStyle = status === 'error' ? theme.statusError : theme.statusWarn;
      ctx.fillRect(0, y + 4, 3, this.rowHeight - 8);
    }

    // 展开三角 + 文字
    let lx = 8 + row.depth * 14;
    if (hasChildren) {
      ctx.fillStyle = theme.textSecondary;
      ctx.beginPath();
      const cy = y + this.rowHeight / 2;
      if (isOpen) {
        ctx.moveTo(lx, cy - 2);
        ctx.lineTo(lx + 8, cy - 2);
        ctx.lineTo(lx + 4, cy + 4);
      } else {
        ctx.moveTo(lx + 1, cy - 4);
        ctx.lineTo(lx + 7, cy);
        ctx.lineTo(lx + 1, cy + 4);
      }
      ctx.closePath();
      ctx.fill();
    }
    lx += 13;
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    const label = this.labelOf
      ? this.labelOf(node)
      : node.kind === 'group'
        ? `${node.name} ×${node.count}`
        : node.name;
    ctx.fillText(this.truncatedLabel(ctx, node.id, label, this.labelWidth - lx - 6), lx, y + this.rowHeight / 2);

    // 色块区域(裁剪到时间区)
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.labelWidth, AXIS_H, this.width - this.labelWidth, this.height - AXIS_H);
    ctx.clip();

    if (this.shapeFor(node) === 'point') {
      // 瞬时事件:菱形标记,居中于 start
      const cx = this.xOf(node.start);
      if (cx >= this.labelWidth - 8 && cx <= this.width + 8) {
        const cy = y + this.rowHeight / 2;
        const r = Math.min(6, (this.rowHeight - 8) / 2);
        ctx.beginPath();
        ctx.moveTo(cx, cy - r);
        ctx.lineTo(cx + r, cy);
        ctx.lineTo(cx, cy + r);
        ctx.lineTo(cx - r, cy);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
        if (node === this.selected) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = theme.selection;
          ctx.stroke();
          ctx.lineWidth = 1;
        } else if (node === this.hoverNode) {
          ctx.strokeStyle = theme.selection;
          ctx.stroke();
        }
      }
      ctx.restore();
      return;
    }

    const bx0 = this.xOf(node.start);
    const bx1 = this.xOf(node.start + node.duration);
    if (!(bx1 < this.labelWidth || bx0 > this.width)) {
      const bw = Math.max(2, bx1 - bx0);
      const by = y + 5;
      const bh = this.rowHeight - 10;

      if (node.kind === 'group' && !isOpen) {
        // 折叠组:浅色容器 + 成员刻痕 + 描边
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = color;
        roundRect(ctx, bx0, by, bw, bh, 3);
        ctx.fill();
        ctx.globalAlpha = 1;
        for (const m of node.children ?? []) {
          const mx = this.xOf(m.start);
          const mw = Math.max(1.5, this.xOf(m.start + m.duration) - mx);
          ctx.fillStyle = color;
          ctx.fillRect(mx, by + bh - 6, mw, 4);
        }
        ctx.lineWidth = node === this.hoverNode ? 2 : 1.2;
        ctx.strokeStyle = color;
        roundRect(ctx, bx0, by, bw, bh, 3);
        ctx.stroke();
        ctx.lineWidth = 1;
      } else {
        ctx.fillStyle = color;
        roundRect(ctx, bx0, by, bw, bh, 3);
        ctx.fill();
        if (node === this.hoverNode && node !== this.selected) {
          ctx.strokeStyle = theme.selection;
          ctx.stroke();
        }
      }
      if (node === this.selected) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = theme.selection;
        roundRect(ctx, bx0, by, bw, bh, 3);
        ctx.stroke();
        ctx.lineWidth = 1;
      }

      // 色块后的耗时文字
      const suffix =
        node.kind === 'group'
          ? `${this.fmt(node.total)} / ×${node.count}`
          : this.fmt(node.duration);
      ctx.fillStyle = theme.textSecondary;
      ctx.textAlign = 'left';
      if (bx1 + ctx.measureText(suffix).width + 10 < this.width) {
        ctx.fillText(suffix, Math.max(bx1, this.labelWidth) + 6, y + this.rowHeight / 2);
      }
    }
    ctx.restore();
  }

  // ================= 交互 =================

  private zoomAt(factor: number, px?: number): void {
    const pivot = px ?? (this.labelWidth + this.width) / 2;
    const tc = this.tOf(pivot);
    this.v0 = tc - (tc - this.v0) * factor;
    this.v1 = tc + (this.v1 - tc) * factor;
    this.clampView();
    this.draw();
    this.emitView();
  }

  private readonly handleWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (e.ctrlKey || e.metaKey) {
      if (px > this.labelWidth) this.zoomAt(Math.exp(e.deltaY * 0.0035), px);
      return;
    }
    if (e.shiftKey) {
      const dt = ((e.deltaY || e.deltaX) / (this.width - this.labelWidth)) * (this.v1 - this.v0);
      this.v0 += dt;
      this.v1 += dt;
      const desiredV0 = this.v0;
      this.clampView();
      this.maybeReachEdge(desiredV0, this.v1 - this.v0);
      this.draw();
      this.emitView();
      return;
    }
    this.scrollY += e.deltaY;
    this.clampScroll();
    this.draw();
  };

  private readonly handleMouseDown = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.drag = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      v0: this.v0,
      v1: this.v1,
      scrollY: this.scrollY,
      moved: 0
    };
    this.canvas.style.cursor = 'grabbing';
  };

  private readonly handleMouseMove = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    if (this.drag) {
      const dx = px - this.drag.x;
      const dy = py - this.drag.y;
      this.drag.moved = Math.max(this.drag.moved, Math.abs(dx), Math.abs(dy));
      const dt = (-dx / (this.width - this.labelWidth)) * (this.drag.v1 - this.drag.v0);
      this.v0 = this.drag.v0 + dt;
      this.v1 = this.drag.v1 + dt;
      const desiredV0 = this.v0;
      this.clampView();
      this.maybeReachEdge(desiredV0, this.v1 - this.v0);
      this.scrollY = this.drag.scrollY - dy;
      this.clampScroll();
      this.hideTooltip();
      this.draw();
      this.emitView();
      return;
    }

    this.hoverRow = py > AXIS_H ? Math.floor((py - AXIS_H + this.scrollY) / this.rowHeight) : -1;
    this.hoverNode = null;
    if (this.hoverRow >= 0 && this.hoverRow < this.rows.length) {
      const node = this.rows[this.hoverRow].node;
      this.canvas.style.cursor = 'pointer';
      if (px > this.labelWidth) {
        const [x0, x1] = this.barHitRange(node);
        if (px >= x0 && px <= x1) this.hoverNode = node;
      }
    } else {
      this.hoverRow = -1;
      this.canvas.style.cursor = 'grab';
    }

    if (this.hoverNode && this.tooltipRenderer !== false) {
      const html = this.tooltipRenderer(this.hoverNode, this.expanded.has(this.hoverNode.id));
      this.tooltipEl.innerHTML = html;
      this.tooltipEl.style.display = 'block';
      let tx = px + 14;
      if (tx + 290 > this.width) tx = Math.max(0, px - 300);
      this.tooltipEl.style.left = `${tx}px`;
      this.tooltipEl.style.top = `${py + 12}px`;
    } else {
      this.hideTooltip();
    }
    this.draw();
  };

  private readonly handleMouseLeave = (): void => {
    this.hideTooltip();
    this.hoverNode = null;
    this.hoverRow = -1;
    this.draw();
  };

  private readonly handleMinimapMouseDown = (e: MouseEvent): void => {
    this.minimapDragging = true;
    this.seekMinimap(e);
  };

  private handleWindowMouseMove(e: MouseEvent): void {
    if (this.minimapDragging) this.seekMinimap(e);
  }

  private handleWindowMouseUp(e: MouseEvent): void {
    this.minimapDragging = false;
    if (!this.drag) return;
    const wasClick = this.drag.moved < 4;
    const startX = this.drag.x;
    const startY = this.drag.y;
    this.drag = null;
    this.canvas.style.cursor = 'grab';
    if (!wasClick) {
      this.draw();
      return;
    }
    // 点击:用按下时的位置判定行,避免松开时轻微位移
    void e;
    // 先判是否点中末端「加载更多」图标:直接触发加载,并标记加载后滑到新数据
    if (this.onReachEdge && this.endHintHit(startX, startY)) {
      this.pendingPanToEnd = true;
      this.reachedEdge = 'end'; // 防止紧随的拖动重复触发
      this.startSpin(); // 进入加载态,图标开始旋转,直到 setData 并入数据
      this.onReachEdge('end', [this.v0, this.v1]);
      return;
    }
    const idx = startY > AXIS_H ? Math.floor((startY - AXIS_H + this.scrollY) / this.rowHeight) : -1;
    if (idx >= 0 && idx < this.rows.length) {
      const node = this.rows[idx].node;
      if (isExpandable(node)) {
        if (this.expanded.has(node.id)) this.expanded.delete(node.id);
        else this.expanded.add(node.id);
        this.flatten();
        this.clampScroll();
        this.onExpandChange?.(this.getExpanded());
      } else {
        this.selected = node;
        this.panToNodeTime(node); // 选中的色块在视口外时,平移把它带进来
        this.onSelect?.(node);
      }
    } else if (startX > 0) {
      this.selected = null;
      this.onSelect?.(null);
    }
    this.draw();
  }

  private seekMinimap(e: MouseEvent): void {
    if (!this.minimapCanvas) return;
    const rect = this.minimapCanvas.getBoundingClientRect();
    const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const [e0, e1] = this.extent;
    const t = e0 + ratio * (e1 - e0);
    const span = this.v1 - this.v0;
    this.v0 = t - span / 2;
    this.v1 = t + span / 2;
    this.clampView();
    this.draw();
    this.emitView();
  }

  private hideTooltip(): void {
    this.tooltipEl.style.display = 'none';
  }

  private emitView(): void {
    this.onViewChange?.([this.v0, this.v1]);
  }

}
