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
  /** id → DFS 序号(缩略图 y 定位用) */
  orderIdx: Map<string, number>;
  /** 节点总数(≥1) */
  totalCount: number;
}

/** 能否展开:hasChildren 显式标记优先,否则按已加载的 children 推导(懒加载预留) */
export function isExpandable(node: TraceNode): boolean {
  return node.hasChildren === true || (!!node.children && node.children.length > 0);
}

/** 深度优先建立索引:byId / parents / allSpans / orderIdx / totalCount */
export function indexTree(data: TraceNode[]): TreeIndex {
  const byId = new Map<string, TraceNode>();
  const parents = new Map<string, string>();
  const orderIdx = new Map<string, number>();
  const allSpans: TraceNode[] = [];
  let count = 0;
  const walk = (nodes: TraceNode[], parent: TraceNode | null): void => {
    for (const n of nodes) {
      byId.set(n.id, n);
      if (parent) parents.set(n.id, parent.id);
      orderIdx.set(n.id, count);
      count += 1;
      if (n.kind === 'span') allSpans.push(n);
      if (n.children && n.children.length > 0) walk(n.children, n);
    }
  };
  walk(data, null);
  return { byId, parents, allSpans, orderIdx, totalCount: Math.max(count, 1) };
}

/** 由索引推导时间全域 [t0, t1],左右各留 2% 余量 */
export function deriveExtent(byId: Map<string, TraceNode>): [number, number] {
  if (byId.size === 0) return [0, 1000];
  let lo = Infinity;
  let hi = -Infinity;
  byId.forEach((n) => {
    lo = Math.min(lo, n.start);
    hi = Math.max(hi, n.start + n.duration);
  });
  const pad = Math.max((hi - lo) * 0.02, 10);
  return [lo - pad, hi + pad];
}

/** 把展开状态下的可见行拍平成数组(纵向虚拟滚动的输入) */
export function flattenRows(data: TraceNode[], expanded: Set<string>): Row[] {
  const rows: Row[] = [];
  const rec = (nodes: TraceNode[], depth: number): void => {
    for (const n of nodes) {
      rows.push({ node: n, depth });
      if (expanded.has(n.id) && n.children && n.children.length > 0) {
        rec(n.children, depth + 1);
      }
    }
  };
  rec(data, 0);
  return rows;
}
