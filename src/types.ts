/**
 * Tracelane 数据模型
 * 时间统一使用毫秒,start 是相对时间线原点(offset 0 / origin)的偏移。
 * 该原点对应的绝对时钟(epoch ms)可经 TracelaneOptions.originEpoch 告知组件,
 * 据此把 offset 还原成墙钟时间;向后加载历史时 offset 可为负。
 * 接入真实数据时建议以服务端时钟为锚点换算,避免端云时钟偏差。
 */

export interface TraceNodeBase {
  /** 全局唯一 id(对应后端 spanId / groupKey 实例 id) */
  id: string;
  /** 展示名称,例如 "POST /api/order" */
  name: string;
  /** 类别 key;可选地在 TracelaneOptions.categories 注册颜色与文案,未注册则按 key 稳定取调色板色、以 key 自身作文案 */
  category: string;
  /** 起点,相对时间线原点的毫秒偏移 */
  start: number;
  /** 持续毫秒数 */
  duration: number;
  /** 因果子节点(下游行为),展开行时渲染 */
  children?: TraceNode[];
  /**
   * 「逻辑上有子节点」,与 children 是否已加载解耦。懒加载(展开即拉取)时子节点
   * 尚未拉取、children 为空,置 true 仍会画展开箭头并允许点击展开以触发加载。
   * 缺省时由 children 长度推导,故一次性喂全数据的场景无需设置。
   */
  hasChildren?: boolean;
  /** 业务自定义负载,会在回调中原样带回(traceId / 用户 / 设备等) */
  meta?: Record<string, unknown>;
}

/** 单个行为 */
export interface SpanNode extends TraceNodeBase {
  kind: 'span';
}

/** 同类行为折叠组,children 即组内成员 */
export interface GroupNode extends TraceNodeBase {
  kind: 'group';
  /** 成员个数 */
  count: number;
  /** 成员耗时之和(区别于 duration = 首尾跨度) */
  total: number;
}

export type TraceNode = SpanNode | GroupNode;

/** 语义状态,由 statusOf 注入,驱动行左缘 accent */
export type NodeStatus = 'ok' | 'warn' | 'error';

/** 时间区的几何形态:bar = 有时长的条;point = 瞬时事件(菱形) */
export type BarShape = 'bar' | 'point';

export interface CategoryStyle {
  /** 类别文案,例如 "iOS 端" */
  label: string;
  /** 色块颜色 */
  color: string;
}

export interface TracelaneTheme {
  text: string;
  textSecondary: string;
  textTertiary: string;
  grid: string;
  rowHover: string;
  /** 选中描边色 */
  selection: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipShadow: string;
  minimapViewportFill: string;
  minimapViewportStroke: string;
  scrollbar: string;
  /** 实心色块内的文字色 */
  barLabel: string;
  /** statusOf 返回 'error' 时的行左缘 accent 色 */
  statusError: string;
  /** statusOf 返回 'warn' 时的行左缘 accent 色 */
  statusWarn: string;
  fontFamily: string;
}

/** 主题覆盖:在某个预设(默认 light)上覆盖部分 token */
export type ThemeOverride = Partial<TracelaneTheme> & {
  /** 覆盖所基于的预设,默认 'light';传 'dark' 即「在 dark 上微调」 */
  extends?: 'light' | 'dark';
};

/** theme 选项:预设名 | 覆盖对象 */
export type ThemeInput = 'light' | 'dark' | ThemeOverride;

export interface FoldOptions {
  /** 相邻两次重复之间允许的最大空闲间隔(ms),超过则切成两组,默认 12000 */
  gap?: number;
  /** 连续重复达到该次数才折叠,默认 3 */
  minCount?: number;
  /** 折叠键,默认 `${category}|${name 中数字归一为 {n}}` */
  keyOf?: (node: TraceNode) => string;
  /** 折叠组展示名,默认取归一化后的 name */
  groupName?: (key: string, members: TraceNode[]) => string;
}

export interface TracelaneOptions {
  /** 顶层节点(用户行为 / trace 根 / 折叠组),按 start 排序展示 */
  data: TraceNode[];
  /**
   * 类别注册表:颜色 + 文案。可选——未注册的 category 会按 key 稳定哈希
   * 从内置调色板取色、以 key 自身作文案,因此"自由数据"无需事先穷举类别。
   */
  categories?: Record<string, CategoryStyle>;
  /** 时间线全域 [t0, t1],缺省时由数据推导并左右各留 2% 余量 */
  timeExtent?: [number, number];
  /**
   * offset 0(时间线原点)对应的绝对时钟,epoch ms。一经设定视为不可变。
   * 设置后可用 getOriginEpoch()/epochOf()/dateOf() 把内部 offset 还原成墙钟时间
   * (绝对时间轴、跨批增量加载对齐的基础)。未设时这些方法返回 undefined。
   * 建议配合 resolveOrigin():先在首批上算出一个固定 origin,再把同一个值同时
   * 作为各批 mapping 的 origin 与此处的 originEpoch 传入。
   */
  originEpoch?: number;
  /** 初始视口 [v0, v1],缺省为全域 */
  initialView?: [number, number];
  /** 初始展开的节点 id */
  defaultExpandedIds?: string[];
  /** 主画布高度(css px),默认 300 */
  height?: number;
  /** 行高,默认 26 */
  rowHeight?: number;
  /** 左侧文字栏宽度,默认 170 */
  labelWidth?: number;
  /** 是否渲染全局缩略图,默认 true */
  minimap?: boolean;
  /** 缩略图高度,默认 46 */
  minimapHeight?: number;
  /** 'light' | 'dark' | 覆盖对象(可带 extends 指定基底,默认 light) */
  theme?: ThemeInput;
  /** 时间格式化,默认 <1s 显示 ms,否则显示 s。仅管时长(tooltip / 色块后缀),不管墙钟刻度 */
  formatTime?: (ms: number) => string;
  /**
   * 时间轴标签模式:
   * - 'elapsed'（默认）：相对 origin 的时段(0 ms / 2.00 s)，即现有行为
   * - 'absolute'：墙钟时间(需 originEpoch；缺则回退 elapsed 并 warn 一次)
   * - 'auto'：视野窄/贴近原点时用 elapsed，拉宽或进入历史(负 offset)时自动转绝对(带滞回防抖)
   */
  axis?: 'elapsed' | 'absolute' | 'auto';
  /** 绝对轴的时区,默认 'local'(DST 感知);'utc' 无 DST。完整 IANA 落点留作后续,标签可经 formatAxis 自定义 */
  timezone?: 'local' | 'utc';
  /** 'auto' 模式下判定转绝对的视野跨度阈值(ms),默认 60000;带 ±20% 滞回 */
  autoAbsoluteThresholdMs?: number;
  /**
   * 绝对刻度标签格式化,默认 formatAxisDefault(按粒度分级 + 日界日期)。独立于 formatTime。
   * unit/stepMs/isDayBoundary 描述当前刻度档与是否本地日界。
   */
  formatAxis?: (
    epochMs: number,
    ctx: {
      unit: 'ms' | 's' | 'min' | 'hour' | 'day' | 'month' | 'year';
      stepMs: number;
      isDayBoundary: boolean;
    }
  ) => string;
  /**
   * 表现编码 · 颜色:覆盖类别色(标签文字、色块、缩略图均生效)。
   * 返回 undefined 时退回类别色。可据延迟/错误/状态自由着色。
   */
  colorOf?: (node: TraceNode) => string | undefined;
  /** 表现编码 · 左栏文案:返回整行显示名(默认折叠组带 ×N) */
  labelOf?: (node: TraceNode) => string;
  /**
   * 表现编码 · 几何形态:'point' 画菱形标记(瞬时事件),'bar' 画时长条。
   * 缺省时 duration<=0 自动判为 'point'。
   */
  shapeOf?: (node: TraceNode) => BarShape;
  /** 表现编码 · 语义状态:'error'/'warn' 在行左缘画 accent;返回 undefined 不画 */
  statusOf?: (node: TraceNode) => NodeStatus | undefined;
  /** 自定义 tooltip HTML;传 false 关闭 tooltip */
  tooltip?: false | ((node: TraceNode, expanded: boolean) => string);
  /** 点击叶子行(或取消选中)时触发 */
  onSelect?: (node: TraceNode | null) => void;
  /** 展开集合变化时触发 */
  onExpandChange?: (expandedIds: string[]) => void;
  /** 时间视口变化时触发(缩放/平移/缩略图寻址) */
  onViewChange?: (view: [number, number]) => void;
  /**
   * 滑到时间边缘的回调(传了即开启「滑动加载更多」):用户把时间视口拖/滚到数据
   * 起点('start')或末端('end')之外时触发一次,接入方据此异步拉新数据,再用
   * `appendData(nodes)`(或 `setData(merged, { keepView: true })`)增量并入。
   * 已去抖:停在同一边缘只触发一次,离开该边缘或数据更新后重新武装。
   */
  onReachEdge?: (edge: 'start' | 'end', view: [number, number]) => void;
  /**
   * 实时跟随态变化回调(进入/退出 live)。配合 `setLive` / `jumpToNow` / `isLive`:开启后
   * 末端新数据到达时视口自动推进到最新;用户手动平移/缩放/纵向滚动即退出(回到历史浏览)。
   * host 据此渲染 Live/History 徽标与「回到当下」按钮。纯可选,不开启则无任何影响。
   */
  onLiveChange?: (live: boolean) => void;
  /**
   * 显式开启向后(历史)加载。开启后:视口贴到数据**起点**时左缘画加载图标(可点击)、
   * 拖到起点触发 onReachEdge('start') 并进入加载态;并入更旧数据后用「基于时间的锚点」
   * 保持视口中心行不跳动。不开启则只有右缘('end')有 UI,只接 end 的用户行为不变。
   * 配合 setEdgeExhausted('start') 在拉到空批次时收掉「还有更多」提示。
   */
  backfill?: boolean;
  /**
   * 保留的节点数上限(含所有层级)。`appendData` 并入后若超过,从**远离本次加载方向的一端**
   * 丢弃整支顶层 trace(向后加载→丢最新、向前加载→丢最旧),并用同一时间锚点保持视口不跳。
   * 用于历史大数据的内存/性能上界。缺省 = 不限(原行为)。
   */
  maxNodes?: number;
  /**
   * 缩略图的「整条时间线总域」[t0, t1](或返回它的函数,可随实时增长)。仅影响缩略图显示:
   * 把已加载段画成总域里的亮色子区、两侧未加载部分画成暗色肩部,便于在大历史里定位。
   * 纯显示——不改 clampView / 边缘检测(它们仍按已加载 extent)。不传则缩略图按已加载 extent 铺满(原行为)。
   */
  totalDomain?: [number, number] | (() => [number, number]);
}
