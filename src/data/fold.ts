/**
 * 同类行为折叠:把"同类、连续、达到次数门槛"的重复行为(心跳、分页、批量 SQL)
 * 折叠成带 ×N 计数的 GroupNode。与 adapter 正交,通常在 fromFlatSpans 之后套用。
 */
import type { FoldOptions, GroupNode, SpanNode, TraceNode } from '../types';
import { createGroup } from './factory';

/** 默认折叠键:类别 + 名称中的数字归一为 {n} */
function defaultKeyOf(node: TraceNode): string {
  return `${node.category}|${node.name.replace(/\d+/g, '{n}')}`;
}

function defaultGroupName(key: string): string {
  const i = key.indexOf('|');
  return i >= 0 ? key.slice(i + 1) : key;
}

/**
 * 同类行为折叠:对同一层级的兄弟节点,把"同折叠键、连续发生、
 * 相邻间隔 < gap、次数 >= minCount"的 span 折叠成 GroupNode。
 * 已是 group 的节点不参与折叠。返回按 start 排序的新数组,不修改入参。
 */
export function foldSiblings(children: TraceNode[], options: FoldOptions = {}): TraceNode[] {
  const gap = options.gap ?? 12000;
  const minCount = options.minCount ?? 3;
  const keyOf = options.keyOf ?? defaultKeyOf;
  const groupName = options.groupName ?? defaultGroupName;

  const byKey = new Map<string, SpanNode[]>();
  for (const child of children) {
    if (child.kind !== 'span') continue;
    const key = keyOf(child);
    const arr = byKey.get(key);
    if (arr) arr.push(child);
    else byKey.set(key, [child]);
  }

  const folded = new Set<TraceNode>();
  const groups: GroupNode[] = [];

  byKey.forEach((arr, key) => {
    const sorted = [...arr].sort((a, b) => a.start - b.start);
    let run: SpanNode[] = [];
    const flush = () => {
      if (run.length >= minCount) {
        const g = createGroup(groupName(key, run), run[0].category, run);
        groups.push(g);
        run.forEach((m) => folded.add(m));
      }
      run = [];
    };
    for (const node of sorted) {
      const last = run[run.length - 1];
      if (last && node.start - (last.start + last.duration) >= gap) flush();
      run.push(node);
    }
    flush();
  });

  const rest = children.filter((c) => !folded.has(c));
  return [...rest, ...groups].sort((a, b) => a.start - b.start);
}

/** 对整棵树递归应用 foldSiblings(每层各自折叠) */
export function foldTree(nodes: TraceNode[], options: FoldOptions = {}): TraceNode[] {
  const walked = nodes.map((n) =>
    n.children && n.children.length > 0 && n.kind === 'span'
      ? { ...n, children: foldTree(n.children, options) }
      : n
  );
  return foldSiblings(walked, options);
}
