/**
 * 树的索引与布局 —— 纯函数,无副作用,与渲染/DOM 解耦。
 * Tracelane 组件把数据交给这里得到索引和可见行,自身只管编排与绘制。
 */
import type { TraceNode } from '../types';

export interface Row {
  node: TraceNode;
  depth: number;
}

export interface TreeIndex {
  /** id → 节点 */
  byId: Map<string, TraceNode>;
  /** 子 id → 父 id */
  parents: Map<string, string>;
  /** 仅 span 节点,DFS 序(缩略图用) */
  allSpans: TraceNode[];
  /** 与 allSpans 对齐的全节点 DFS 序号(= orderIdx.get(span.id));缩略图免去逐 span 的 Map 查找 */
  allSpansOrder: number[];
  /** id → DFS 序号(缩略图 y 定位用) */
  orderIdx: Map<string, number>;
  /** 节点总数(≥1) */
  totalCount: number;
  /** 时间全域 [t0, t1],左右各留 2% 余量(与索引同趟 DFS 求出,免二次遍历) */
  extent: [number, number];
  /** 未加 padding 的原始 min(start);空树为 Infinity。增量追加时用于合并 extent */
  rawLo: number;
  /** 未加 padding 的原始 max(start+duration);空树为 -Infinity */
  rawHi: number;
}

/** 由原始 [lo, hi] 求带 2% 余量的展示 extent;空(lo>hi)回退 [0,1000] */
export function paddedExtent(lo: number, hi: number): [number, number] {
  if (!(lo <= hi)) return [0, 1000];
  const pad = Math.max((hi - lo) * 0.02, 10);
  return [lo - pad, hi + pad];
}

/** 能否展开:hasChildren 显式标记优先,否则按已加载的 children 推导(懒加载预留) */
export function isExpandable(node: TraceNode): boolean {
  return node.hasChildren === true || (!!node.children && node.children.length > 0);
}

/**
 * 深度优先建立索引,同趟一并求出时间全域 extent —— 免去原先 deriveExtent 的二次全量遍历。
 * 产出:byId / parents / allSpans / allSpansOrder / orderIdx / totalCount / extent。
 */
export function indexTree(data: TraceNode[]): TreeIndex {
  const byId = new Map<string, TraceNode>();
  const parents = new Map<string, string>();
  const orderIdx = new Map<string, number>();
  const allSpans: TraceNode[] = [];
  const allSpansOrder: number[] = [];
  let count = 0;
  let lo = Infinity;
  let hi = -Infinity;
  const walk = (nodes: TraceNode[], parent: TraceNode | null): void => {
    for (const n of nodes) {
      byId.set(n.id, n);
      if (parent) parents.set(n.id, parent.id);
      orderIdx.set(n.id, count);
      if (n.start < lo) lo = n.start;
      const end = n.start + n.duration;
      if (end > hi) hi = end;
      if (n.kind === 'span') {
        allSpans.push(n);
        allSpansOrder.push(count);
      }
      count += 1;
      if (n.children && n.children.length > 0) walk(n.children, n);
    }
  };
  walk(data, null);
  return {
    byId,
    parents,
    allSpans,
    allSpansOrder,
    orderIdx,
    totalCount: Math.max(count, 1),
    extent: paddedExtent(lo, hi),
    rawLo: lo,
    rawHi: hi
  };
}

/**
 * 把展开状态下的可见行拍平成数组(纵向虚拟滚动的输入)。
 * hidden 给出被类别过滤隐藏的类别 key:命中的节点连同其因果子树整支跳过。
 */
export function flattenRows(data: TraceNode[], expanded: Set<string>, hidden?: Set<string>): Row[] {
  const rows: Row[] = [];
  const rec = (nodes: TraceNode[], depth: number): void => {
    for (const n of nodes) {
      if (hidden && hidden.has(n.category)) continue; // 隐藏该类别的 span 连同其因果子树
      rows.push({ node: n, depth });
      if (expanded.has(n.id) && n.children && n.children.length > 0) {
        rec(n.children, depth + 1);
      }
    }
  };
  rec(data, 0);
  return rows;
}

/** 收集未被类别过滤隐藏的 span(隐藏类别及其子树整支跳过);缩略图据此同步过滤 */
export function collectVisibleSpans(data: TraceNode[], hidden: Set<string>): TraceNode[] {
  const out: TraceNode[] = [];
  const rec = (nodes: TraceNode[]): void => {
    for (const n of nodes) {
      if (hidden.has(n.category)) continue;
      if (n.kind === 'span') out.push(n);
      if (n.children && n.children.length > 0) rec(n.children);
    }
  };
  rec(data);
  return out;
}
