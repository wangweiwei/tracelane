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
import { type Row, collectVisibleSpans, flattenRows, indexTree, isExpandable, paddedExtent } from './tree';
import { defaultTooltip } from './tooltip';
import { Minimap } from './minimap';
import {
  type CalendarTick,
  type TimeUnit,
  type TimeZoneMode,
  calendarTicks,
  formatAxisDefault,
  pickCalendarStep
} from './timeScale';

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
/** 触发边缘加载所需的「拉过边缘」距离(px)。贴边的轻微抖动不触发,需明确把视口拖出此距离 */
const EDGE_PULL_PX = 64;
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
  private readonly axisMode: 'elapsed' | 'absolute' | 'auto';
  private readonly timezone: TimeZoneMode;
  private readonly autoAbsoluteThresholdMs: number;
  private readonly fmtAxis: (
    epochMs: number,
    ctx: { unit: TimeUnit; stepMs: number; isDayBoundary: boolean }
  ) => string;
  /** 'auto' 模式的绝对/时段闩锁;带滞回防止在阈值/原点接缝处逐帧翻转 */
  private axisAbsoluteLatched = false;
  /** 绝对轴刻度+标签单槽缓存:键含 v0|v1|W|tz|origin;视口不变的帧(spin/纵滚)直接复用,0 重算 */
  private axisCache: { key: string; ticks: CalendarTick[]; labels: string[] } | null = null;
  /** originEpoch 缺失时只 warn 一次 */
  private warnedNoOrigin = false;
  private readonly tooltipRenderer: false | ((node: TraceNode, expanded: boolean) => string);
  private readonly colorOf?: (node: TraceNode) => string | undefined;
  private readonly labelOf?: (node: TraceNode) => string;
  private readonly shapeOf?: (node: TraceNode) => BarShape;
  private readonly statusOf?: (node: TraceNode) => NodeStatus | undefined;
  private readonly onSelect?: (node: TraceNode | null) => void;
  private readonly onExpandChange?: (ids: string[]) => void;
  private readonly onViewChange?: (view: [number, number]) => void;
  private readonly onReachEdge?: (edge: 'start' | 'end', view: [number, number]) => void;
  /** 实时跟随态变化回调(进入/退出 live);host 据此渲染 Live/History 徽标 */
  private readonly onLiveChange?: (live: boolean) => void;
  /** 显式开启向后(历史)加载:仅此时画左缘提示并对 'start' 边缘做加载态(不影响只接 end 的用户) */
  private readonly backfill: boolean;
  /** 缩略图总域(或其 getter);纯显示用,不改 clamp/边缘检测。未设则缩略图按 extent 铺满 */
  private readonly totalDomain?: [number, number] | (() => [number, number]);
  /** 保留节点数上限;appendData 超限时从远端非对称淘汰整支 trace。未设 = 不限 */
  private readonly maxNodes?: number;

  private data: TraceNode[] = [];
  private extentFromOptions: [number, number] | undefined;
  /** offset 0 对应的绝对时钟(epoch ms);不可变。未设则绝对时间相关方法返回 undefined */
  private readonly originEpoch?: number;
  private extent: [number, number] = [0, 1000];
  private v0 = 0;
  private v1 = 1000;
  private scrollY = 0;

  private expanded = new Set<string>();
  private rows: Row[] = [];
  private byId = new Map<string, TraceNode>();
  private parents = new Map<string, string>();
  private allSpans: TraceNode[] = [];
  /** 与 allSpans 对齐的 DFS 序号;缩略图直接按下标取,省去逐 span 的 orderIdx.get */
  private allSpansOrder: number[] = [];
  private orderIdx = new Map<string, number>();
  private totalCount = 0;
  /** indexTree 同趟求出的时间全域(未被 timeExtent 覆盖时用) */
  private derivedExtent: [number, number] = [0, 1000];
  /** 未加 padding 的原始 lo/hi;增量尾部追加时据此合并 extent,免全量重扫 */
  private rawLo = Infinity;
  private rawHi = -Infinity;
  /** 被类别过滤隐藏的类别 key;隐藏其 span 连同因果子树。空=全显示 */
  private hiddenCategories = new Set<string>();
  /** allSpans 去掉「被隐藏类别及其子树」后的结果,供缩略图过滤渲染 */
  private filteredSpans: TraceNode[] = [];

  private width = 0;
  private hoverNode: TraceNode | null = null;
  private hoverRow = -1;
  /** 上次 tooltip 内容对应的 `${id}|${expanded}` 键;键不变则跳过 innerHTML 重建 */
  private lastTooltipKey = '';
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
  /** 向后(历史)加载:点左缘图标 / 拖到起点后置位,下次并入数据时露出新历史 */
  private pendingPanToStart = false;
  /** 实时跟随:为真时新数据(末端增长)自动推进视口到最新;用户手动平移/缩放即退出 */
  private live = false;
  /** 各侧加载图标的起转时刻(0=未转);两侧独立,支持 start/end 并发各自转各自的 */
  private spinAt: { start: number; end: number } = { start: 0, end: 0 };
  /** 各侧加载安全超时句柄(接入方迟迟不返回时自动停那一侧) */
  private spinTimer: { start: number | null; end: number | null } = { start: null, end: null };
  /** 各侧「已到头」:host 拉到空批次时经 setEdgeExhausted 置位 → 收掉「还有更多」提示 */
  private edgeExhausted: { start: boolean; end: boolean } = { start: false, end: false };
  /** 旋转动画 rAF 循环句柄(任一侧在转即运行) */
  private spinRaf: number | null = null;

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
    this.axisMode = options.axis ?? 'elapsed';
    this.timezone = options.timezone ?? 'local';
    this.autoAbsoluteThresholdMs = options.autoAbsoluteThresholdMs ?? 60_000;
    this.fmtAxis = options.formatAxis ?? ((e, ctx) => formatAxisDefault(e, { ...ctx, tz: this.timezone }));
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
    this.onLiveChange = options.onLiveChange;
    this.backfill = options.backfill ?? false;
    this.totalDomain = options.totalDomain;
    this.maxNodes = options.maxNodes;
    this.extentFromOptions = options.timeExtent;
    this.originEpoch = options.originEpoch;

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
      overflowWrap: 'anywhere', // 长 URL/无空格串在框内换行,不溢出边框(继承给标题与子行)
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

  /**
   * 替换数据。keepView 为 true 时保留当前时间视口与滚动位置。
   * opts.incremental(仅 appendData 尾部追加快路用):传入「本次新增的顶层 trace」,此时跳过全量
   * indexTree,只把新批增量并入索引(旧节点序号不变),把每批从 O(总量)降到 O(本批量)。
   */
  setData(
    data: TraceNode[],
    opts: { keepView?: boolean; silent?: boolean; incremental?: TraceNode[] } = {}
  ): void {
    const prevEnd = this.extent[1]; // 用于点击加载后滑到新数据
    const prevStart = this.extent[0]; // 向后加载露出新历史用
    // 无跳动锚点(§7.5):并入前记下视口中心行的「时间 offset」(fold 不变量),
    // 并入后用就近匹配把它放回同一纵向像素 —— 前插更旧数据时行不下跳。
    const viewportH = this.height - AXIS_H;
    const anchor =
      opts.keepView && this.rows.length > 0
        ? {
            centerIdx: Math.floor((this.scrollY + viewportH / 2) / this.rowHeight),
            offset: 0 as number
          }
        : null;
    if (anchor) {
      const row = this.rows[Math.min(Math.max(anchor.centerIdx, 0), this.rows.length - 1)];
      anchor.offset = row.node.start;
    }
    this.data = data;
    if (opts.incremental) {
      // 增量:只并入新批,旧索引与旧截断标签缓存全部保留(尾部追加不改既有节点)
      this.appendIndexInPlace(opts.incremental);
      this.refreshFilteredSpans();
    } else {
      this.indexData();
      this.labelCache.clear(); // 全量替换:数据变了,截断标签缓存作废
    }
    this.extent = this.extentFromOptions ?? this.derivedExtent;
    this.minimap?.markDirty(); // 数据/extent/orderIdx 变了,缩略图缓存作废
    this.reachedEdge = null; // extent 变了(可能追加了数据),重新武装边缘回调
    // 停掉「数据已落地」那一侧的图标:keepView 时按哪端增长精确停那端(并发加载不会误停另一端),
    // 全量替换则两端都停。
    const grewEnd = this.extent[1] > prevEnd;
    const grewStart = this.extent[0] < prevStart;
    if (!opts.keepView) this.clearSpin();
    else {
      if (grewEnd) this.clearSpin('end');
      if (grewStart) this.clearSpin('start');
    }
    const valid = new Set([...this.expanded].filter((id) => this.byId.has(id)));
    this.expanded = valid;
    if (this.selected && !this.byId.has(this.selected.id)) this.selected = null;
    this.flatten();
    if (!opts.keepView) {
      this.v0 = this.extent[0];
      this.v1 = this.extent[1];
      this.scrollY = 0;
      this.pendingPanToEnd = false;
      this.pendingPanToStart = false;
    } else if (this.live && grewEnd) {
      // 实时跟随:贴住最新一端,新数据进来即自动推进到末端 + 滚到底部
      const span = this.v1 - this.v0;
      this.v1 = this.extent[1];
      this.v0 = this.v1 - span;
      this.scrollY = Number.MAX_SAFE_INTEGER; // 由 clampScroll 收到 maxScroll(最新行在底部)
      this.pendingPanToEnd = false;
      this.pendingPanToStart = false;
    } else {
      // 纵向:把锚点行放回原像素位置(就近匹配 offset;append 到底部时 newIdx==centerIdx,自动无操作)
      if (anchor) {
        const newIdx = this.rowIndexClosestToOffset(anchor.offset);
        if (newIdx >= 0) this.scrollY += (newIdx - anchor.centerIdx) * this.rowHeight;
      }
      // 横向:露出新追加的一段。两端独立 —— 露出实际增长的那端,并留出离边缘的余量,
      // 避免小批量时贴边导致立刻再触发(§B1)。
      const span = this.v1 - this.v0;
      const margin = span * 0.05;
      const [e0, e1] = this.extent;
      const room = e1 - e0 > span + margin;
      if (this.pendingPanToEnd && grewEnd) {
        this.v1 = room ? Math.min(prevEnd + span * 0.85, e1 - margin) : prevEnd + span * 0.85;
        this.v0 = this.v1 - span;
      } else if (this.pendingPanToStart && grewStart) {
        this.v0 = room ? Math.max(prevStart - span * 0.85, e0 + margin) : prevStart - span * 0.85;
        this.v1 = this.v0 + span;
      }
      // 复位「数据已到」那端的 pending;另一端(并发加载、数据还没到)保留到它自己的 setData(§B2)
      if (grewEnd) this.pendingPanToEnd = false;
      if (grewStart) this.pendingPanToStart = false;
    }
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
    const hasData = this.data.length > 0;
    let inMin = Infinity;
    let inMax = -Infinity;
    for (const n of nodes) {
      if (n.start < inMin) inMin = n.start;
      if (n.start > inMax) inMax = n.start;
    }
    const prevMin = hasData ? this.data[0].start : Infinity;
    const prevMax = hasData ? this.data[this.data.length - 1].start : -Infinity;
    // 纯尾部追加(本批整体在现有数据之后):旧节点 DFS 序号不变,可走增量索引快路。
    const tailAppend = hasData && inMin >= prevMax;

    // 快路条件:尾部追加 + 无类别过滤(filteredSpans 与 allSpans 同引用,push 即更新)+ 本批并入后不触发淘汰。
    // 满足时把每批从 O(已加载总量)降到 O(本批量),消除无限滚动二次曲线。其余情况(前插 backfill /
    // 交错 / 需淘汰 / 过滤态)一律走下方全量重建,语义与之前完全一致。
    if (tailAppend && this.hiddenCategories.size === 0) {
      let willEvict = false;
      if (this.maxNodes != null && this.maxNodes > 0) {
        let batchCount = 0;
        for (const n of nodes) batchCount += this.deepCount(n);
        willEvict = this.totalCount + batchCount > this.maxNodes;
      }
      if (!willEvict) {
        // 尾部已按 start 有序,直接 concat 免全量 sort
        this.setData(this.data.concat(nodes), { keepView: true, incremental: nodes });
        return;
      }
    }

    // 全量路径:淘汰方向用并入前数据判定(整体更旧→前插丢最新端;更新→追加丢最旧端;交错→不淘汰)
    let dropFromEnd: boolean | null = null;
    if (this.maxNodes != null && this.maxNodes > 0 && hasData) {
      dropFromEnd = inMax <= prevMin ? true : inMin >= prevMax ? false : null;
    }
    let merged = [...this.data, ...nodes].sort((a, b) => a.start - b.start);
    if (dropFromEnd !== null) merged = this.evictToCap(merged, dropFromEnd);
    this.setData(merged, { keepView: true });
  }

  /** 节点(含后代)总数 */
  private deepCount(node: TraceNode): number {
    let n = 1;
    if (node.children) for (const c of node.children) n += this.deepCount(c);
    return n;
  }

  /**
   * 非对称淘汰到 maxNodes:dropFromEnd 决定丢哪一端(true=丢最新端,前插场景;false=丢最旧端,
   * 追加场景),始终保留靠近本次加载方向、用户正在看的那侧。整支顶层 trace 为单位丢弃,至少留 1 支。
   */
  private evictToCap(sorted: TraceNode[], dropFromEnd: boolean): TraceNode[] {
    const cap = this.maxNodes as number;
    const counts = sorted.map((n) => this.deepCount(n));
    let total = counts.reduce((a, b) => a + b, 0);
    if (total <= cap) return sorted;
    let lo = 0;
    let hi = sorted.length;
    while (total > cap && hi - lo > 1) {
      if (dropFromEnd) {
        hi -= 1;
        total -= counts[hi];
      } else {
        total -= counts[lo];
        lo += 1;
      }
    }
    return sorted.slice(lo, hi);
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

  /** offset 0 对应的绝对时钟(epoch ms);未设 originEpoch 时返回 undefined */
  getOriginEpoch(): number | undefined {
    return this.originEpoch;
  }

  /** 内部 offset(ms)→ 绝对时钟 epoch ms;未设 originEpoch 时返回 undefined(不返回 NaN) */
  epochOf(offset: number): number | undefined {
    return this.originEpoch == null ? undefined : this.originEpoch + offset;
  }

  /** 内部 offset(ms)→ Date;未设 originEpoch 时返回 undefined(不返回 Invalid Date) */
  dateOf(offset: number): Date | undefined {
    const e = this.epochOf(offset);
    return e == null ? undefined : new Date(e);
  }

  /** 当前是否处于实时跟随态 */
  isLive(): boolean {
    return this.live;
  }

  /**
   * 开/关实时跟随。开启时把视口推进到最新一端(等同 jumpToNow);用户手动平移/缩放/纵向滚动
   * 会自动退出(见 exitLive)。状态变化触发 onLiveChange,供 host 渲染 Live/History 徽标。
   */
  setLive(on: boolean): void {
    if (on) {
      this.jumpToNow();
      return;
    }
    if (!this.live) return;
    this.live = false;
    this.onLiveChange?.(false);
    this.draw();
  }

  /** 跳到当下:视口推进到数据最新一端、滚到底部,并进入实时跟随态(可一键逆转 = setLive(false)) */
  jumpToNow(): void {
    const span = this.v1 - this.v0;
    this.v1 = this.extent[1];
    this.v0 = this.v1 - span;
    this.scrollY = this.maxScroll();
    this.clampView();
    this.clampScroll();
    const was = this.live;
    this.live = true;
    if (!was) this.onLiveChange?.(true);
    this.emitView();
    this.draw();
  }

  /** 用户手动操作视口时退出实时跟随(平移/缩放/纵向滚动都算接管) */
  private exitLive(): void {
    if (!this.live) return;
    this.live = false;
    this.onLiveChange?.(false);
  }

  /**
   * 标记某侧「已到头 / 重新有数据」。host 的 onReachEdge 处理器拉到**空批次**时调
   * setEdgeExhausted('start') 收掉左缘「还有更多」提示;之后若又拿到更早数据,用
   * setEdgeExhausted('start', false) 重新武装。
   */
  setEdgeExhausted(edge: 'start' | 'end', exhausted = true): void {
    if (this.edgeExhausted[edge] === exhausted) return;
    this.edgeExhausted[edge] = exhausted;
    // 空批次到头时 host 不会 appendData/setData(没有数据可并),故这里负责停掉该侧在转的图标,
    // 否则它会一直转到 12s 安全超时。同时丢弃该侧待露出的标记。
    if (exhausted && this.isSpinning(edge)) {
      this.clearSpin(edge);
      if (edge === 'end') this.pendingPanToEnd = false;
      else this.pendingPanToStart = false;
    }
    this.draw();
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

  /**
   * 展开全部(已加载的)可展开节点,与 collapseAll 对称。直接迭代现成的 byId 索引,
   * 只收可展开节点(不污染 expanded 状态),不重新遍历数据树。渲染虚拟化,代价仅一次
   * O(N) 展平。超大数据(数十万节点)时这一下展平可能被感知,是否加确认由应用层决定。
   */
  expandAll(): void {
    const next = new Set<string>();
    this.byId.forEach((node, id) => {
      if (isExpandable(node)) next.add(id);
    });
    this.expanded = next;
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
    this.allSpansOrder = idx.allSpansOrder;
    this.orderIdx = idx.orderIdx;
    this.totalCount = idx.totalCount;
    this.derivedExtent = idx.extent;
    this.rawLo = idx.rawLo;
    this.rawHi = idx.rawHi;
    this.refreshFilteredSpans();
  }

  /**
   * 增量索引:仅把「新追加的顶层 trace」并入现有索引,旧节点的 byId/parents/orderIdx/allSpans 全部
   * 保持不变(仅适用于纯尾部追加 —— 旧节点 DFS 序号不变)。把每批从 O(已加载总量)降到 O(本批量),
   * 消除无限滚动的二次曲线。仅 appendData 的尾部追加快路调用,前提见调用处。
   */
  private appendIndexInPlace(newRoots: TraceNode[]): void {
    let count = this.totalCount; // 旧总数即下一个 DFS 序号(进入此路时已加载非空 → totalCount=实数)
    let lo = this.rawLo;
    let hi = this.rawHi;
    const walk = (nodes: TraceNode[], parent: TraceNode | null): void => {
      for (const n of nodes) {
        this.byId.set(n.id, n);
        if (parent) this.parents.set(n.id, parent.id);
        this.orderIdx.set(n.id, count);
        if (n.start < lo) lo = n.start;
        const end = n.start + n.duration;
        if (end > hi) hi = end;
        if (n.kind === 'span') {
          this.allSpans.push(n);
          this.allSpansOrder.push(count);
        }
        count += 1;
        if (n.children && n.children.length > 0) walk(n.children, n);
      }
    };
    walk(newRoots, null);
    this.totalCount = Math.max(count, 1);
    this.rawLo = lo;
    this.rawHi = hi;
    this.derivedExtent = paddedExtent(lo, hi);
  }

  private flatten(): void {
    this.rows = flattenRows(this.data, this.expanded, this.hiddenCategories);
  }

  /**
   * 可见行中 node.start 最接近给定 offset 的行下标(无跳动锚点用)。
   * 行按 DFS 序、非全局时间序,故线性扫描取最近;每次并入只跑一次,O(rows) 可接受。
   */
  private rowIndexClosestToOffset(offset: number): number {
    let best = -1;
    let bestDiff = Infinity;
    for (let i = 0; i < this.rows.length; i += 1) {
      const diff = Math.abs(this.rows[i].node.start - offset);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }
    return best;
  }

  /**
   * 缩略图 x 映射的时间域:有 totalDomain 用之(并入 extent,保证已加载数据不落到域外),
   * 否则就是已加载 extent(原行为)。纯显示用 —— clampView / maybeReachEdge 不读它。
   */
  private currentDomain(): [number, number] {
    if (!this.totalDomain) return this.extent;
    const td = typeof this.totalDomain === 'function' ? this.totalDomain() : this.totalDomain;
    return [Math.min(td[0], this.extent[0]), Math.max(td[1], this.extent[1])];
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
    // 视宽不超过全域;起点夹在 [e0, e1-span] 内 —— 不允许越界到已加载数据之外的空白
    // (越界会把数据之外的空白标成刻度,并把缩略图视口框推出边界裁掉)。
    // 注:向后加载历史(backfill)无需放宽这里 —— 边缘检测 maybeReachEdge 读的是 clampView
    // **之前**捕获的 desiredV0,贴左缘继续拖即触发 onReachEdge('start'),与末端('end')同理。
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
    // 去敏:必须把视口「拉过」边缘 EDGE_PULL_PX 这段明确距离才触发加载 ——
    // 贴边的轻微抖动/惯性不再误触发。px 阈值按当前缩放换算成时间过冲量,缩放无关。
    const innerW = Math.max(this.width - this.labelWidth, 1);
    const pull = (EDGE_PULL_PX / innerW) * span;
    let edge: 'start' | 'end' | null = null;
    if (desiredV0 < e0 - pull) edge = 'start';
    else if (desiredV0 + span > e1 + pull) edge = 'end';
    if (edge === null) {
      this.reachedEdge = null; // 离开边缘,重新武装
    } else if (this.reachedEdge !== edge) {
      this.reachedEdge = edge; // 置位即去抖:即便下面因到头/在载不 fire,也不会每帧重复进来
      if (this.edgeExhausted[edge]) return; // 该侧已到头:不再 fire/spin,免得空转 + 反复打扰 host
      // 串行化:同一时刻只允许一个加载在途。已有一侧在加载时,不再 fire/转另一侧 ——
      // 避免「库抢先转圈、host 单守卫挡掉请求 → 假 spinner 空转到 12s 超时 / 双 spinner」。
      // (load 完成后 setData 收尾、reachedEdge 重置,下一侧照常能触发,只挡同时、不挡先后。)
      if (this.isSpinning()) return;
      // 拖到边缘即触发加载(无限滚动,不靠点击):该侧进入加载态(转 spinner)并标记待露出。
      // 'start' 仅在显式 backfill 时启用。
      if (edge === 'end' || (edge === 'start' && this.backfill)) {
        this.startSpin(edge);
        if (edge === 'end') this.pendingPanToEnd = true;
        else this.pendingPanToStart = true;
      }
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
    // spin 动画的独立 rAF 循环本就每帧 render(读最新状态),此时再排一帧是同帧双重整帧渲染 —— 跳过。
    if (this.spinRaf !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.render();
    });
  }

  /** 本帧时间轴是否用绝对(墙钟)标签;'auto' 带滞回,详见设计文档 §4 */
  private resolveAxisAbsolute(): boolean {
    if (this.axisMode === 'elapsed') return false;
    if (this.originEpoch == null) {
      if (this.axisMode === 'absolute' && !this.warnedNoOrigin) {
        this.warnedNoOrigin = true;
        // eslint-disable-next-line no-console
        console.warn('[tracelane] axis:"absolute" 需要 originEpoch,未提供 → 回退 elapsed');
      }
      return false;
    }
    if (this.axisMode === 'absolute') return true;
    // auto:span 阈值带 ±20% 滞回;v0<0 原点接缝带死区,避免逐帧翻转
    const span = this.v1 - this.v0;
    const thr = this.autoAbsoluteThresholdMs;
    const seamBand = Math.abs(span) * 0.01;
    if (this.axisAbsoluteLatched) {
      if (span <= thr * 0.8 && this.v0 > seamBand) this.axisAbsoluteLatched = false;
    } else if (span >= thr * 1.2 || this.v0 < -seamBand) {
      this.axisAbsoluteLatched = true;
    }
    return this.axisAbsoluteLatched;
  }

  /** 画时间轴网格线 + 标签:elapsed 走 niceStep+formatTime;absolute 走日历刻度+formatAxis */
  private drawTimeAxis(W: number, H: number): void {
    const { ctx, theme } = this;
    ctx.textAlign = 'center';
    if (this.resolveAxisAbsolute() && this.originEpoch != null) {
      const origin = this.originEpoch;
      // 刻度+标签只依赖 (v0, v1, W, tz, origin) —— 同视口的帧(spin/纵滚/hover)直接复用,
      // 跳过逐 tick 的 new Date / calendarTicks / 标签拼串(键变才重算)。
      const key = `${this.v0}|${this.v1}|${W}|${this.timezone}|${origin}`;
      let cache = this.axisCache;
      if (!cache || cache.key !== key) {
        const targetTicks = Math.max((W - this.labelWidth) / 85, 1);
        const stepSel = pickCalendarStep(this.v1 - this.v0, targetTicks);
        const ticks = calendarTicks(origin + this.v0, origin + this.v1, stepSel, origin, this.timezone);
        const labels = ticks.map((tk) =>
          this.fmtAxis(tk.abs, { unit: tk.unit, stepMs: stepSel.approxMs, isDayBoundary: tk.isDayBoundary })
        );
        cache = { key, ticks, labels };
        this.axisCache = cache;
      }
      const { ticks, labels } = cache;
      for (let i = 0; i < ticks.length; i += 1) {
        const tk = ticks[i];
        const px = this.xOf(tk.offset);
        ctx.strokeStyle = theme.grid;
        ctx.beginPath();
        ctx.moveTo(px, AXIS_H);
        ctx.lineTo(px, H);
        ctx.stroke();
        if (tk.isDayBoundary) {
          ctx.font = `600 11px ${theme.fontFamily}`;
          ctx.fillStyle = theme.textSecondary; // 日界:加粗日期 chip
        } else {
          ctx.fillStyle = theme.textTertiary;
        }
        ctx.fillText(labels[i], px, 10);
        if (tk.isDayBoundary) ctx.font = `11px ${theme.fontFamily}`; // 复位,免影响后续
      }
      return;
    }
    const step = niceStep((this.v1 - this.v0) / Math.max((W - this.labelWidth) / 85, 1));
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
  }

  private render(): void {
    if (this.destroyed || this.width === 0) return;
    const { ctx, theme } = this;
    const W = this.width;
    const H = this.height;
    ctx.clearRect(0, 0, W, H);
    ctx.font = `11px ${theme.fontFamily}`;
    ctx.textBaseline = 'middle';

    // 时间轴刻度(elapsed 时段 / absolute 墙钟,按 axis 解析)
    this.drawTimeAxis(W, H);

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
      // 未过滤时 filteredSpans 即 allSpans,可用对齐的 order 数组免 Map 查找;过滤态传 null 回退
      order: this.filteredSpans === this.allSpans ? this.allSpansOrder : null,
      orderIdx: this.orderIdx,
      totalCount: this.totalCount,
      extent: this.extent,
      domain: this.currentDomain(),
      v0: this.v0,
      v1: this.v1,
      colorFor: (n) => this.colorFor(n)
    });
  }

  /** 末端加载提示当前是否可见(开启 onReachEdge、未到头、且视口紧贴末端) */
  private endHintVisible(): boolean {
    if (!this.onReachEdge || this.edgeExhausted.end) return false;
    const eps = Math.max((this.v1 - this.v0) * 1e-4, 0.5);
    return this.extent[1] - this.v1 <= eps;
  }

  /** 起点(历史)加载提示是否可见(需 backfill、未到头、且视口紧贴起点) */
  private startHintVisible(): boolean {
    if (!this.onReachEdge || !this.backfill || this.edgeExhausted.start) return false;
    const eps = Math.max((this.v1 - this.v0) * 1e-4, 0.5);
    return this.v0 - this.extent[0] <= eps;
  }

  /** 加载 spinner 中心(右缘,垂直居中) */
  private endHintCenter(): { cx: number; cy: number } {
    return { cx: this.width - 18, cy: AXIS_H + (this.height - AXIS_H) / 2 };
  }

  /** 加载 spinner 中心(左缘文字栏右侧,垂直居中) */
  private startHintCenter(): { cx: number; cy: number } {
    return { cx: this.labelWidth + 18, cy: AXIS_H + (this.height - AXIS_H) / 2 };
  }

  /**
   * 边缘加载的视觉反馈(两端逐边、同一套规则,左/右/双侧表现一致):
   * - 正在加载该侧 → 画 spinner(转圈);
   * - 否则若该侧贴边且可加载(未到头)→ 画一抹极淡的边缘渐隐,暗示「这边还能拖出更多」。
   * 不画可点图标、不参与点击 —— 触发只靠拖到边缘(无限滚动)。
   */
  private drawEdgeHints(): void {
    if (this.isSpinning('end')) {
      const { cx, cy } = this.endHintCenter();
      this.drawRefreshIcon(cx, cy, false, this.spinAt.end);
    } else if (this.endHintVisible()) {
      this.drawEdgeFade('end');
    }
    if (this.isSpinning('start')) {
      const { cx, cy } = this.startHintCenter();
      this.drawRefreshIcon(cx, cy, true, this.spinAt.start);
    } else if (this.startHintVisible()) {
      this.drawEdgeFade('start');
    }
  }

  /** 极淡的边缘渐隐:从该侧边缘向内 fade 到透明,提示「这边还有更多」。两端镜像对称。 */
  private drawEdgeFade(side: 'start' | 'end'): void {
    const { ctx } = this;
    const top = AXIS_H;
    const h = this.height - AXIS_H;
    const w = 40;
    const edgeX = side === 'start' ? this.labelWidth : this.width;
    const innerX = side === 'start' ? this.labelWidth + w : this.width - w;
    const base = this.edgeFadeBase(); // 主题感知:暗底用白、亮底用黑
    const g = ctx.createLinearGradient(edgeX, top, innerX, top);
    g.addColorStop(0, `rgba(${base}, 0.13)`); // 边缘最淡影
    g.addColorStop(1, `rgba(${base}, 0)`); // 向内透明
    ctx.fillStyle = g;
    ctx.fillRect(Math.min(edgeX, innerX), top, w, h);
  }

  /** 边缘渐隐基色:按主题文字亮度判定暗/亮主题 —— 暗主题(亮字)用白影,亮主题用黑影 */
  private edgeFadeBase(): string {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(this.theme.text);
    if (!m) return '127, 127, 127';
    const lum = (parseInt(m[1], 16) + parseInt(m[2], 16) + parseInt(m[3], 16)) / 3;
    return lum > 128 ? '255, 255, 255' : '0, 0, 0';
  }

  /** 画刷新/加载图标。mirror 水平翻转(用于左缘);spinSince>0 时按其起转时刻匀速旋转 */
  private drawRefreshIcon(cx: number, cy: number, mirror: boolean, spinSince: number): void {
    const { ctx, theme } = this;
    const r = 6.5;
    ctx.save();
    ctx.translate(cx, cy);
    if (mirror) ctx.scale(-1, 1);
    if (spinSince > 0) {
      // 加载中:按时间匀速旋转(~1.1 圈/秒)
      ctx.rotate(((performance.now() - spinSince) / 1000) * Math.PI * 2 * 1.1);
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

  /** 是否有边在转(不传 edge 则任一侧) */
  private isSpinning(edge?: 'start' | 'end'): boolean {
    return edge ? this.spinAt[edge] > 0 : this.spinAt.start > 0 || this.spinAt.end > 0;
  }

  /** 让某侧进入加载态:起转该侧图标 + 该侧安全超时;start/end 可并发各自转。 */
  private startSpin(edge: 'start' | 'end'): void {
    if (this.spinAt[edge] > 0) return; // 该侧已在转
    this.spinAt[edge] = performance.now();
    if (this.spinRaf === null) {
      const tick = (): void => {
        if (this.destroyed || !this.isSpinning()) {
          this.spinRaf = null;
          return;
        }
        this.render();
        this.spinRaf = requestAnimationFrame(tick);
      };
      this.spinRaf = requestAnimationFrame(tick);
    }
    if (this.spinTimer[edge] !== null) clearTimeout(this.spinTimer[edge] as number);
    this.spinTimer[edge] = window.setTimeout(() => this.stopSpin(edge), 12000);
  }

  /** 清理旋转状态(不重绘)。传 edge 只停那一侧,不传停两侧;无侧在转则停 rAF。 */
  private clearSpin(edge?: 'start' | 'end'): void {
    const edges: ('start' | 'end')[] = edge ? [edge] : ['start', 'end'];
    for (const e of edges) {
      this.spinAt[e] = 0;
      if (this.spinTimer[e] !== null) {
        clearTimeout(this.spinTimer[e] as number);
        this.spinTimer[e] = null;
      }
    }
    if (!this.isSpinning() && this.spinRaf !== null) {
      cancelAnimationFrame(this.spinRaf);
      this.spinRaf = null;
    }
  }

  /** 安全超时回调:停某侧转并恢复静止。加载迟迟不返回(超时)即放弃该侧待露出,
   *  避免之后某个无关的 keepView setData 把视口意外平移过去。 */
  private stopSpin(edge: 'start' | 'end'): void {
    if (this.spinAt[edge] === 0) return;
    this.clearSpin(edge);
    if (edge === 'end') this.pendingPanToEnd = false;
    else this.pendingPanToStart = false;
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
    this.exitLive(); // 滚轮缩放/平移/纵向滚动都算用户接管 → 退出实时跟随
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
      if (this.drag.moved >= 4) this.exitLive(); // 真正拖动了 → 用户接管,退出实时跟随
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

    // 先算新命中,再与上次对比 —— 仅当命中行/节点变化时才重绘 canvas;
    // 在静止内容上滑动(命中不变)不再每帧整帧 render,大幅降交互期 CPU/GC。
    const prevRow = this.hoverRow;
    const prevNode = this.hoverNode;
    let newRow = py > AXIS_H ? Math.floor((py - AXIS_H + this.scrollY) / this.rowHeight) : -1;
    let newNode: TraceNode | null = null;
    if (newRow >= 0 && newRow < this.rows.length) {
      const node = this.rows[newRow].node;
      this.canvas.style.cursor = 'pointer';
      if (px > this.labelWidth) {
        const [x0, x1] = this.barHitRange(node);
        if (px >= x0 && px <= x1) newNode = node;
      }
    } else {
      newRow = -1;
      this.canvas.style.cursor = 'grab';
    }
    this.hoverRow = newRow;
    this.hoverNode = newNode;

    if (newNode && this.tooltipRenderer !== false) {
      // 内容仅在「节点 + 展开态」变化时重建(innerHTML 解析+重建 DOM 远贵于改样式);位置每次跟随。
      // 把展开态纳入键:展开/折叠后停在同一 group 上,tooltip 文案不会陈旧(默认 tooltip 的 group 分支依赖它)。
      const key = `${newNode.id}|${this.expanded.has(newNode.id)}`;
      if (key !== this.lastTooltipKey) {
        this.tooltipEl.innerHTML = this.tooltipRenderer(newNode, this.expanded.has(newNode.id));
        this.lastTooltipKey = key;
      }
      this.tooltipEl.style.display = 'block'; // 确保可见(拖拽期间曾被 hideTooltip)
      let tx = px + 14;
      if (tx + 290 > this.width) tx = Math.max(0, px - 300);
      this.tooltipEl.style.left = `${tx}px`;
      this.tooltipEl.style.top = `${py + 12}px`;
    } else {
      this.hideTooltip();
    }
    if (newRow !== prevRow || newNode !== prevNode) this.draw();
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
    // 注:边缘加载不靠点击触发 —— 拖到边缘即由 maybeReachEdge 触发(无限滚动),
    // 这里只处理行的展开/选中。
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
    const [d0, d1] = this.currentDomain(); // 与缩略图显示一致(总域),点哪定位到哪
    const t = d0 + ratio * (d1 - d0);
    const span = this.v1 - this.v0;
    this.v0 = t - span / 2;
    this.v1 = t + span / 2;
    this.clampView();
    this.draw();
    this.emitView();
  }

  private hideTooltip(): void {
    this.tooltipEl.style.display = 'none';
    this.lastTooltipKey = ''; // 隐藏后强制下次 hover 重建,避免复用过期内容
  }

  private emitView(): void {
    this.onViewChange?.([this.v0, this.v1]);
  }

}
