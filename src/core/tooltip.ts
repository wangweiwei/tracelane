/**
 * 默认 tooltip 渲染 —— 纯函数。接入方可用 options.tooltip 整体覆盖。
 */
import type { CategoryStyle, TraceNode, TracelaneTheme } from '../types';
import { escapeHtml } from '../utils';

export interface TooltipCtx {
  categoryOf: (node: TraceNode) => CategoryStyle;
  theme: TracelaneTheme;
  fmt: (ms: number) => string;
}

/** 折叠组未展开时展示成员统计,否则展示起点/耗时 */
export function defaultTooltip(node: TraceNode, expandedNow: boolean, ctx: TooltipCtx): string {
  const cat = ctx.categoryOf(node);
  const name = escapeHtml(node.name);
  const sub = `color:${ctx.theme.textSecondary}`;
  if (node.kind === 'group' && !expandedNow) {
    const avg = node.total / node.count;
    return (
      `<div style="font-weight:500;">${name} ×${node.count}</div>` +
      `<div style="${sub}">${escapeHtml(cat.label)} · 跨度 ${ctx.fmt(node.duration)}<br>` +
      `累计 ${ctx.fmt(node.total)} · 均值 ${ctx.fmt(avg)} · 点击行展开</div>`
    );
  }
  const dur = node.kind === 'group' ? node.total : node.duration;
  return (
    `<div style="font-weight:500;">${name}</div>` +
    `<div style="${sub}">${escapeHtml(cat.label)} · 起点 ${ctx.fmt(node.start)} · 耗时 ${ctx.fmt(dur)}</div>`
  );
}
