/**
 * 节点工厂:手搓数据时用。接入真实数据通常走 adapter(fromFlatSpans / fromTree)。
 */
import type { GroupNode, SpanNode, TraceNode } from '../types';
import { uid } from '../utils';

/** 创建单个行为节点 */
export function createSpan(
  name: string,
  category: string,
  start: number,
  duration: number,
  children?: TraceNode[],
  meta?: Record<string, unknown>
): SpanNode {
  return { kind: 'span', id: uid('s'), name, category, start, duration, children, meta };
}

/** 由成员创建折叠组,start/duration/count/total 自动计算 */
export function createGroup(
  name: string,
  category: string,
  members: TraceNode[],
  meta?: Record<string, unknown>
): GroupNode {
  if (members.length === 0) {
    throw new Error('[tracelane] createGroup 需要至少一个成员');
  }
  const start = Math.min(...members.map((m) => m.start));
  const end = Math.max(...members.map((m) => m.start + m.duration));
  const total = members.reduce((acc, m) => acc + m.duration, 0);
  return {
    kind: 'group',
    id: uid('g'),
    name,
    category,
    start,
    duration: end - start,
    count: members.length,
    total,
    children: members,
    meta
  };
}
