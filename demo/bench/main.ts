/**
 * tracelane · benchmark harness
 * ------------------------------------------------------------------
 * 压力数据 + 性能 HUD,用来对着"真实数字"做性能优化(P0 基线)。
 * canonical demo(/)是小数据的真实展示,验证不了性能;这里才是性能验证面。
 *
 * 只喂 SYNCHRONOUS 的 Tracelane 构造/setData,不改任何契约。HUD 自带 rAF 循环
 * 测帧节奏(FPS / ms/帧 / 1s 内最差帧),所以无需在组件内部埋点就能量到
 * hover/scroll/drag 时的卡顿。
 * ------------------------------------------------------------------
 */
import { Tracelane, type TraceNode } from '@/index';
import { generateSynthetic } from './generateSynthetic';
import { attachHud } from './hud';

const SIZES = [10_000, 100_000, 500_000, 1_000_000, 2_000_000];

const hud = attachHud();
const mount = document.getElementById('timeline') as HTMLElement;
let tl: Tracelane | null = null;
let currentData: TraceNode[] = [];

/** 读取近似 JS 堆占用(仅 Chromium 暴露 performance.memory) */
function heapMB(): number | null {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? Math.round(mem.usedJSHeapSize / 1048576) : null;
}

/** 统计实际 span 总数 + 收集所有可展开节点 id(用于"全部展开"压力) */
function walk(nodes: TraceNode[], ids: string[]): number {
  let n = 0;
  for (const node of nodes) {
    n += 1;
    if (node.children && node.children.length > 0) {
      ids.push(node.id);
      n += walk(node.children, ids);
    }
  }
  return n;
}

let expandableIds: string[] = [];
let totalSpans = 0;

// —— 滑动加载更多(onReachEdge)演示 ——
const BATCH_TIME = 120_000; // 每批合成数据的时间跨度,与生成器默认一致
let timelineEnd = BATCH_TIME; // 下一批数据接续的起点偏移
let loadCount = 0;

/** 把一批节点的 start 整体后移 offset,使追加数据接在当前末端之后 */
function shiftStarts(nodes: TraceNode[], offset: number): void {
  for (const n of nodes) {
    (n as { start: number }).start += offset;
    if (n.children) shiftStarts(n.children, offset);
  }
}

function load(spanCount: number): void {
  tl?.destroy();
  timelineEnd = BATCH_TIME;
  loadCount = 0;

  const t0 = performance.now();
  currentData = generateSynthetic({ spanCount });
  const tGen = performance.now() - t0;

  expandableIds = [];
  totalSpans = walk(currentData, expandableIds);

  const t1 = performance.now();
  tl = new Tracelane(mount, {
    data: currentData,
    theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
    height: 440,
    onSelect() {
      /* no-op: 基线只看渲染开销 */
    },
    // 滑动加载更多:拖到时间末端 → 异步拉新数据并 appendData 并入(无限滚动)
    onReachEdge(edge) {
      if (edge !== 'end' || !tl) return;
      loadCount += 1;
      const batch = generateSynthetic({ spanCount: 50_000, seed: 100 + loadCount });
      shiftStarts(batch, timelineEnd);
      timelineEnd += BATCH_TIME;
      totalSpans += walk(batch, expandableIds);
      currentData = currentData.concat(batch);
      tl.appendData(batch);
      hud.set('spans', totalSpans);
      hud.set('loads', loadCount);
      const m = heapMB();
      if (m != null) hud.set('heap', `${m} MB`);
    }
  });
  const tBuild = performance.now() - t1;

  hud.set('spans', totalSpans);
  hud.set('expandable', expandableIds.length);
  hud.set('dpr', window.devicePixelRatio || 1);
  hud.mark('generate', tGen);
  hud.mark('construct', tBuild);
  const mb = heapMB();
  if (mb != null) hud.set('heap', `${mb} MB`);
}

/** 全部展开:压 flatten()/虚拟化(P2 目标);展开后滚动/ hover 应仍流畅 */
function expandAll(): void {
  if (!tl) return;
  const t0 = performance.now();
  tl.setExpanded(expandableIds);
  hud.mark('expandAll', performance.now() - t0);
  const mb = heapMB();
  if (mb != null) hud.set('heap', `${mb} MB`);
}

function collapseAll(): void {
  if (!tl) return;
  const t0 = performance.now();
  tl.collapseAll();
  hud.mark('collapseAll', performance.now() - t0);
}

// 规模切换按钮
const sizes = document.getElementById('sizes') as HTMLElement;
for (const n of SIZES) {
  const btn = document.createElement('button');
  btn.textContent = n.toLocaleString('en-US');
  btn.addEventListener('click', () => load(n));
  sizes.appendChild(btn);
}

// 压力开关
document.getElementById('expand-all')?.addEventListener('click', expandAll);
document.getElementById('collapse-all')?.addEventListener('click', collapseAll);

// 默认先加载 10 万(够大但秒开),其余按需切
load(100_000);

// 侧栏切换主题时同步组件(bench 会按规模重建,这里切当前实例)
window.addEventListener('tl-theme', (e) => {
  tl?.setTheme((e as CustomEvent<'light' | 'dark'>).detail);
});
