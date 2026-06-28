/**
 * 结构映射(缝①):把任意来源的原始数据收敛到内部规范模型 TraceNode[]。
 *
 * 设计取舍:
 * - 一次性转换(eager),内部仍是干净的规范树,fold / 虚拟渲染 / 折叠组合成不受影响。
 * - id 一律用调用方提供的稳定 id(不自动生成),以便 defaultExpandedIds / reveal /
 *   未来的增量追加跨刷新对得上。
 * - 时间锚定归适配器独占:start 为绝对时钟(epoch ms),内部存相对 origin 的偏移,
 *   绝对值与原始行经 meta 原样带回。origin 默认取全集 min(start)。
 * - 与折叠正交:需要折叠时在外面套 foldTree(fromFlatSpans(...))。
 */
import type { CategoryStyle, SpanNode, TraceNode } from '../types';
import { CATEGORY_PALETTE } from '../theme';

/** 访问器:既可传字段名(从行上取值),也可传函数(任意计算) */
export type Get<R, T> = (keyof R & string) | ((row: R) => T);

function read<R, T>(row: R, get: Get<R, T>): T {
  return typeof get === 'function' ? get(row) : (row[get] as unknown as T);
}

/** T+0 锚点:'auto' 取全集 min(start);number 显式锚(如服务端时钟);函数自定义 */
export type Origin<R> = 'auto' | number | ((rows: R[]) => number);

export interface FlatMapping<R> {
  /** 全局唯一 id(对应 spanId);作为稳定 id 原样使用 */
  id: Get<R, string>;
  /** 父 id(对应 parentSpanId);空 / 父不存在 => 视为根 */
  parentId: Get<R, string | null | undefined>;
  /** 展示名 */
  name: Get<R, string>;
  /** 类别 key(端 / 服务名 / 机房等任意维度) */
  category: Get<R, string>;
  /** 起点,绝对时钟毫秒(epoch ms);内部换算为相对 origin 的偏移 */
  start: Get<R, number>;
  /** 持续毫秒;<=0 的节点默认渲染为瞬时事件(菱形) */
  duration: Get<R, number>;
  /** 时间锚点,默认 'auto' */
  origin?: Origin<R>;
  /** 自定义 meta,默认把原始行整体带回 */
  meta?: (row: R) => Record<string, unknown>;
}

export interface TreeMapping<R> {
  id: Get<R, string>;
  name: Get<R, string>;
  category: Get<R, string>;
  start: Get<R, number>;
  duration: Get<R, number>;
  /** 子节点访问器;返回空数组 / undefined 即叶子 */
  children?: Get<R, R[] | undefined>;
  origin?: Origin<R>;
  meta?: (row: R) => Record<string, unknown>;
}

/**
 * 解析时间锚点(T+0 对应的绝对时钟 epoch ms)。
 * 'auto' 取 rows 的 min(start);number 显式锚;函数自定义。
 *
 * 公开导出:增量加载需要「跨批用同一个固定 origin」对齐坐标。调用方先用本函数
 * 在首批上算出一个 epoch,然后把它同时作为每一批的 `mapping.origin` 和构造器的
 * `originEpoch` 传入,即可保证前向/后向各批的 offset 落在同一坐标系。
 */
export function resolveOrigin<R>(
  rows: R[],
  mapping: { start: Get<R, number>; origin?: Origin<R> }
): number {
  const o = mapping.origin ?? 'auto';
  if (typeof o === 'number') return o;
  if (typeof o === 'function') return o(rows);
  let min = Infinity;
  for (const row of rows) {
    const s = Number(read(row, mapping.start));
    if (s < min) min = s;
  }
  return Number.isFinite(min) ? min : 0;
}

/** 各层 children 按 start 升序(渲染器按数组序铺行,必须预排) */
function sortTree(nodes: TraceNode[]): void {
  nodes.sort((a, b) => a.start - b.start);
  for (const n of nodes) {
    if (n.children && n.children.length > 0) sortTree(n.children);
  }
}

/** 沿声明的父链上溯,判断把 childId 挂到 parentId 是否会成环 */
function createsCycle(
  childId: string,
  parentId: string,
  parentIdOf: Map<string, string | null>,
  nodes: Map<string, SpanNode>
): boolean {
  let cur: string | null = parentId;
  const seen = new Set<string>();
  while (cur != null) {
    if (cur === childId) return true; // 上溯回到自身 => 成环
    if (seen.has(cur)) return true; // 上游本身已有环
    seen.add(cur);
    if (!nodes.has(cur)) return false; // 父链在缺失祖先处断开 => 非自环
    cur = parentIdOf.get(cur) ?? null;
  }
  return false;
}

function warnSummary(orphans: number, cycles: number, dups: number): void {
  const parts: string[] = [];
  if (orphans) parts.push(`${orphans} 个孤儿节点(父不存在)已提为根`);
  if (cycles) parts.push(`${cycles} 条父子环已打断并降为根`);
  if (dups) parts.push(`${dups} 个重复 id 被后者覆盖`);
  if (parts.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[tracelane] fromFlatSpans: ${parts.join(';')}`);
  }
}

/**
 * 扁平 span 列表(每条带 parentId)→ 因果树。
 * 边界:孤儿提为根、父子环打断、重复 id 后者覆盖,均汇总一次 console.warn。
 * 返回按 start 排序的顶层节点;不修改入参。
 */
export function fromFlatSpans<R>(rows: R[], mapping: FlatMapping<R>): TraceNode[] {
  if (rows.length === 0) return [];
  const origin = resolveOrigin(rows, mapping);

  const nodes = new Map<string, SpanNode>();
  const parentIdOf = new Map<string, string | null>();
  let dupCount = 0;

  for (const row of rows) {
    const id = String(read(row, mapping.id));
    const pidRaw = read(row, mapping.parentId);
    const node: SpanNode = {
      kind: 'span',
      id,
      name: String(read(row, mapping.name)),
      category: String(read(row, mapping.category)),
      start: Number(read(row, mapping.start)) - origin,
      duration: Number(read(row, mapping.duration)),
      children: undefined,
      meta: mapping.meta ? mapping.meta(row) : (row as unknown as Record<string, unknown>)
    };
    if (nodes.has(id)) dupCount += 1;
    nodes.set(id, node);
    parentIdOf.set(id, pidRaw == null ? null : String(pidRaw));
  }

  const roots: SpanNode[] = [];
  let orphanCount = 0;
  let cycleCount = 0;

  nodes.forEach((node, id) => {
    const pid = parentIdOf.get(id) ?? null;
    if (pid == null) {
      roots.push(node);
      return;
    }
    const parent = nodes.get(pid);
    if (!parent) {
      orphanCount += 1;
      roots.push(node);
      return;
    }
    if (createsCycle(id, pid, parentIdOf, nodes)) {
      cycleCount += 1;
      roots.push(node);
      return;
    }
    (parent.children ??= []).push(node);
  });

  warnSummary(orphanCount, cycleCount, dupCount);
  sortTree(roots);
  return roots;
}

/**
 * 已是嵌套结构的数据 → 规范树:仅做字段重命名 + 时间锚定 + 逐层排序。
 * 返回按 start 排序的顶层节点;不修改入参。
 */
export function fromTree<R>(roots: R[], mapping: TreeMapping<R>): TraceNode[] {
  if (roots.length === 0) return [];
  const childrenGet = mapping.children;

  const all: R[] = [];
  const collect = (rows: R[]): void => {
    for (const r of rows) {
      all.push(r);
      const kids = childrenGet ? read(r, childrenGet) : undefined;
      if (kids && kids.length > 0) collect(kids);
    }
  };
  collect(roots);
  const origin = resolveOrigin(all, mapping);

  const build = (rows: R[]): SpanNode[] => {
    const out = rows.map((r): SpanNode => {
      const kids = childrenGet ? read(r, childrenGet) : undefined;
      return {
        kind: 'span',
        id: String(read(r, mapping.id)),
        name: String(read(r, mapping.name)),
        category: String(read(r, mapping.category)),
        start: Number(read(r, mapping.start)) - origin,
        duration: Number(read(r, mapping.duration)),
        children: kids && kids.length > 0 ? build(kids) : undefined,
        meta: mapping.meta ? mapping.meta(r) : (r as unknown as Record<string, unknown>)
      };
    });
    out.sort((a, b) => a.start - b.start);
    return out;
  };

  return build(roots);
}

/**
 * 扫描数据里出现过的全部类别,按出现顺序从调色板分配颜色,生成 categories 注册表。
 * 按出现顺序取色(而非 paletteColor 的哈希)是有意为之:前 N 个类别保证不撞色,适合做图例;
 * 代价是色值依赖出现顺序。想要"同 key 跨数据集恒定色"则直接用 paletteColor。
 * 不传 categories 时交给 Tracelane 的内置兜底(paletteColor)。
 */
export function autoCategories(
  nodes: TraceNode[],
  palette: readonly string[] = CATEGORY_PALETTE
): Record<string, CategoryStyle> {
  const keys: string[] = [];
  const seen = new Set<string>();
  const walk = (ns: TraceNode[]): void => {
    for (const n of ns) {
      if (n.category && !seen.has(n.category)) {
        seen.add(n.category);
        keys.push(n.category);
      }
      if (n.children && n.children.length > 0) walk(n.children);
    }
  };
  walk(nodes);

  const out: Record<string, CategoryStyle> = {};
  keys.forEach((k, i) => {
    out[k] = { label: k, color: palette[i % palette.length] };
  });
  return out;
}
