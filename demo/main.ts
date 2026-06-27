/**
 * tracelane · demo
 * ------------------------------------------------------------------
 * 演示「把后端原始数据喂给 Tracelane 并挂到页面」的完整流程。
 *
 * 真实接入的形态就是这里的 `rawSpans`:一个扁平的 span 列表,每条带
 * parentSpanId 表达因果父子、start 用绝对时钟(epoch ms)。这正是 OTel /
 * Jaeger 导出的常见形态。`fromFlatSpans` 负责把它收敛成内部规范树:
 *   - 按 parentSpanId 建因果树(孤儿提为根、环打断,均 warn)
 *   - origin:'auto' 把绝对时钟锚定到 T+0,原始行经 meta 原样带回
 * 之后再套 `foldTree` 做同类行为折叠。表现(颜色 / 状态 / 形态)全部走
 * 注入函数,与数据来源解耦。
 * ------------------------------------------------------------------
 */

import {
  Tracelane,
  fromFlatSpans,
  foldTree,
  type CategoryStyle,
  type TraceNode
} from '@/index';

// ============================================================
// 1. 类别注册(可选)
//    categories 现在是可选的:未注册的 category 会按 key 稳定取调色板色、
//    以 key 自身作文案。这里仍显式注册,只为给出中文图例文案。
// ============================================================
const categories: Record<string, CategoryStyle> = {
  ios: { label: 'iOS 端', color: '#378ADD' },
  h5: { label: 'H5 端', color: '#7F77DD' },
  gw: { label: '网关', color: '#D4537E' },
  svc: { label: '服务', color: '#1D9E75' },
  db: { label: '存储', color: '#BA7517' }
};

// ============================================================
// 2. 构造 mock —— 扁平 span 列表(真实项目里这一段来自后端)
//    时间用绝对时钟:BASE 模拟服务端 epoch 锚点,origin:'auto' 会把它抹掉。
// ============================================================
const BASE = 1_700_000_000_000;

interface RawSpan {
  spanId: string;
  parentSpanId?: string;
  label: string;
  service: 'ios' | 'h5' | 'gw' | 'svc' | 'db';
  ts: number; // 绝对毫秒
  dur: number; // 持续毫秒;0 = 瞬时事件
  httpStatus?: number;
  error?: boolean;
}

const rawSpans: RawSpan[] = [];
let seq = 0;
const nextId = (): string => `s${(seq += 1)}`;

/** 追加一条 span,返回其 spanId(供子节点引用为 parentSpanId) */
function push(s: Omit<RawSpan, 'spanId'>): string {
  const spanId = nextId();
  rawSpans.push({ ...s, spanId });
  return spanId;
}

/** 一次「提交订单」:网关 → createOrder → 一串 SQL;fail 时网关 500 */
function orderTrace(t: number, client: 'ios' | 'h5', fail = false): void {
  const root = push({ label: '点击「提交订单」', service: client, ts: BASE + t, dur: 420 });
  const gw = push({
    parentSpanId: root,
    label: 'POST /api/order',
    service: 'gw',
    ts: BASE + t + 60,
    dur: fail ? 1300 : 900,
    httpStatus: fail ? 500 : 200,
    error: fail
  });
  const co = push({
    parentSpanId: gw,
    label: 'createOrder 业务处理',
    service: 'svc',
    ts: BASE + t + 130,
    dur: 780
  });
  push({ parentSpanId: co, label: 'INSERT orders', service: 'db', ts: BASE + t + 180, dur: 110 });
  for (let i = 0; i < 4; i += 1) {
    push({
      parentSpanId: co,
      label: `INSERT order_items #${i + 1}`,
      service: 'db',
      ts: BASE + t + 310 + i * 70,
      dur: 45
    });
  }
  push({ parentSpanId: co, label: 'DECR stock:sku', service: 'db', ts: BASE + t + 640, dur: 35 });
  push({ parentSpanId: co, label: '创建支付单', service: 'svc', ts: BASE + t + 760, dur: 260 });
  push({ parentSpanId: root, label: '渲染收银台', service: client, ts: BASE + t + 1120, dur: 380 });
}

/** 一次「浏览商品流」:6 次分页(各下挂推荐+缓存)+ 8 张懒加载图 */
function feedTrace(t: number, client: 'ios' | 'h5'): void {
  const root = push({ label: '滑动浏览商品流', service: client, ts: BASE + t, dur: 300 });
  for (let i = 0; i < 6; i += 1) {
    const g = push({
      parentSpanId: root,
      label: `GET /api/feed?page=${i + 1}`,
      service: 'gw',
      ts: BASE + t + 150 + i * 420,
      dur: 150,
      httpStatus: 200
    });
    push({
      parentSpanId: g,
      label: `查询推荐 page=${i + 1}`,
      service: 'svc',
      ts: BASE + t + 190 + i * 420,
      dur: 90
    });
    push({ parentSpanId: g, label: `GET feed:${i + 1}`, service: 'db', ts: BASE + t + 205 + i * 420, dur: 25 });
  }
  for (let i = 0; i < 8; i += 1) {
    push({
      parentSpanId: root,
      label: `加载图片 img_${i + 1}`,
      service: client,
      ts: BASE + t + 600 + i * 260,
      dur: 120
    });
  }
}

// 瞬时事件(dur=0):唯一名,不会被折叠,渲染为菱形标记
push({ label: 'App 冷启动完成', service: 'ios', ts: BASE + 200, dur: 0 });
push({ label: '首屏渲染完成', service: 'ios', ts: BASE + 2600, dur: 0 });

// 13 次心跳上报:间隔 10s < 默认 gap(12s),会折叠成「心跳上报 #{n} ×13」
for (let i = 0; i < 13; i += 1) {
  push({ label: `心跳上报 #${i + 1}`, service: 'ios', ts: BASE + 1000 + i * 10000, dur: 0 });
}

feedTrace(3000, 'ios');
orderTrace(15000, 'ios', true); // 这一单网关 500,演示 statusOf / colorOf
feedTrace(30000, 'h5');
orderTrace(50000, 'h5');
feedTrace(70000, 'ios');
orderTrace(90000, 'ios');
feedTrace(105000, 'h5');

// 扁平 → 因果树 → 逐层折叠
const data: TraceNode[] = foldTree(
  fromFlatSpans(rawSpans, {
    id: 'spanId',
    parentId: 'parentSpanId',
    name: 'label',
    category: 'service',
    start: 'ts',
    duration: 'dur',
    origin: 'auto' // 抹掉 BASE,start 归一到 T+0
  })
);

// ============================================================
// 3. 实例化组件
// ============================================================
const firstFeed = data.find((n) => n.name === '滑动浏览商品流');
const firstOrder = data.find((n) => n.name === '点击「提交订单」');
const defaultExpandedIds = [firstFeed?.id, firstOrder?.id].filter(
  (id): id is string => typeof id === 'string'
);

const detail = document.getElementById('detail') as HTMLDivElement;

const tl = new Tracelane(document.getElementById('timeline') as HTMLElement, {
  data,
  categories,
  theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  initialView: [1500, 22000],
  defaultExpandedIds,
  height: 320,

  // 表现编码 · 颜色:错误行标红,其余退回类别色
  colorOf: (node) => (node.meta?.error ? '#E24B4A' : undefined),
  // 表现编码 · 状态:HTTP 5xx 红 accent、4xx 琥珀 accent(读 meta 里的原始字段)
  statusOf: (node) => {
    const code = Number(node.meta?.httpStatus);
    if (code >= 500) return 'error';
    if (code >= 400) return 'warn';
    return undefined;
  },

  // 选中叶子行(或点空白取消)的回调:详情面板渲染权全在接入方。
  onSelect(node) {
    if (!node) {
      detail.style.display = 'none';
      return;
    }
    const cat = categories[node.category] ?? { label: node.category, color: '#888888' };
    const dur = node.kind === 'group' ? node.total : node.duration;
    const code = node.meta?.httpStatus;
    detail.style.display = 'block';
    detail.innerHTML =
      `<div class="name"><span class="chip" style="background:${cat.color}"></span>${node.name}</div>` +
      `<div class="sub">类别:${cat.label} · 开始 T+${Math.round(node.start)} ms · 持续 ${Math.round(dur)} ms` +
      (code != null ? ` · HTTP ${code}` : '') +
      `<br>node.meta 里就是后端原始 span(spanId / parentSpanId / 设备与用户标识等)</div>`;
  }
});

// ============================================================
// 4. 外部工具栏 —— 通过公开方法驱动组件
// ============================================================
document.getElementById('zoom-in')?.addEventListener('click', () => tl.zoomIn());
document.getElementById('zoom-out')?.addEventListener('click', () => tl.zoomOut());
document.getElementById('collapse-all')?.addEventListener('click', () => tl.collapseAll());
document.getElementById('reset')?.addEventListener('click', () => tl.resetView());

// ============================================================
// 5. 图例 —— 由 categories 自动生成,点击可按类别过滤(隐藏整支)
// ============================================================
const legend = document.getElementById('legend') as HTMLDivElement;
const hiddenCats = new Set<string>();
function renderLegend(): void {
  legend.innerHTML = Object.entries(categories)
    .map(([key, c]) => {
      const off = hiddenCats.has(key) ? ' is-off' : '';
      return `<button type="button" class="legend-item${off}" data-cat="${key}" aria-pressed="${!hiddenCats.has(key)}"><span class="chip" style="background:${c.color}"></span>${c.label}</button>`;
    })
    .join('');
}
renderLegend();
legend.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-cat]');
  if (!btn) return;
  const key = btn.dataset.cat as string;
  if (hiddenCats.has(key)) hiddenCats.delete(key);
  else hiddenCats.add(key);
  tl.setHiddenCategories([...hiddenCats]);
  renderLegend();
});

// 顶部侧栏切换主题时,同步切换组件主题(保留视口/展开/选中)
window.addEventListener('tl-theme', (e) => {
  tl.setTheme((e as CustomEvent<'light' | 'dark'>).detail);
});
