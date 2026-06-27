/**
 * Tracelane 数据模型
 * 时间统一使用毫秒,start 是相对时间线原点(T+0)的偏移。
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
  /** 时间格式化,默认 <1s 显示 ms,否则显示 s */
  formatTime?: (ms: number) => string;
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
}
