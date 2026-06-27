/**
 * tracelane · 滑动加载更多 demo
 * ------------------------------------------------------------------
 * 演示 onReachEdge + appendData 实现时间线「无限滚动」:把时间视口拖到最右端
 * 继续往右拖,触发 onReachEdge('end'),模拟异步拉下一段 trace 并 appendData 并入。
 *
 * 关键:每一段都用同一个固定 origin(BASE)做时间锚定,保证跨段坐标对齐——
 * 这正是 appendData 文档里强调的「增量加载请用固定 origin,而非每批 'auto'」。
 * ------------------------------------------------------------------
 */
import {
  Tracelane,
  fromFlatSpans,
  foldTree,
  type CategoryStyle,
  type TraceNode
} from '@/index';

const categories: Record<string, CategoryStyle> = {
  ios: { label: 'iOS 端', color: '#378ADD' },
  h5: { label: 'H5 端', color: '#7F77DD' },
  gw: { label: '网关', color: '#D4537E' },
  svc: { label: '服务', color: '#1D9E75' },
  db: { label: '存储', color: '#BA7517' }
};

const BASE = 1_700_000_000_000; // 固定 epoch 锚点:所有段共用,保证对齐
const PAGE_SPAN = 40_000; // 每段覆盖约 40s

interface RawSpan {
  spanId: string;
  parentSpanId?: string;
  label: string;
  service: 'ios' | 'h5' | 'gw' | 'svc' | 'db';
  ts: number;
  dur: number;
  httpStatus?: number;
  error?: boolean;
}

/** 造第 page 段(从 0 起)的真实 trace,绝对时间落在 [BASE+page·SPAN, +SPAN] 内 */
function makePage(page: number): TraceNode[] {
  const raw: RawSpan[] = [];
  let seq = 0;
  const base = BASE + page * PAGE_SPAN;
  const push = (s: Omit<RawSpan, 'spanId'>): string => {
    const spanId = `p${page}_${(seq += 1)}`;
    raw.push({ ...s, spanId });
    return spanId;
  };

  const order = (t: number, client: 'ios' | 'h5', fail = false): void => {
    const root = push({ label: '点击「提交订单」', service: client, ts: base + t, dur: 420 });
    const gw = push({
      parentSpanId: root,
      label: 'POST /api/order',
      service: 'gw',
      ts: base + t + 60,
      dur: fail ? 1300 : 900,
      httpStatus: fail ? 500 : 200,
      error: fail
    });
    const co = push({ parentSpanId: gw, label: 'createOrder 业务处理', service: 'svc', ts: base + t + 130, dur: 780 });
    push({ parentSpanId: co, label: 'INSERT orders', service: 'db', ts: base + t + 180, dur: 110 });
    for (let i = 0; i < 4; i += 1) {
      push({ parentSpanId: co, label: `INSERT order_items #${i + 1}`, service: 'db', ts: base + t + 300 + i * 70, dur: 45 });
    }
    push({ parentSpanId: co, label: '创建支付单', service: 'svc', ts: base + t + 720, dur: 260 });
    push({ parentSpanId: root, label: '渲染收银台', service: client, ts: base + t + 1100, dur: 380 });
  };

  const feed = (t: number, client: 'ios' | 'h5'): void => {
    const root = push({ label: '滑动浏览商品流', service: client, ts: base + t, dur: 300 });
    for (let i = 0; i < 6; i += 1) {
      const g = push({ parentSpanId: root, label: `GET /api/feed?page=${i + 1}`, service: 'gw', ts: base + t + 150 + i * 420, dur: 150, httpStatus: 200 });
      push({ parentSpanId: g, label: `查询推荐 page=${i + 1}`, service: 'svc', ts: base + t + 190 + i * 420, dur: 90 });
    }
    for (let i = 0; i < 8; i += 1) {
      push({ parentSpanId: root, label: `加载图片 img_${i + 1}`, service: client, ts: base + t + 600 + i * 260, dur: 120 });
    }
  };

  push({ label: `第 ${page + 1} 段 · 首屏渲染完成`, service: 'ios', ts: base + 200, dur: 0 });
  for (let i = 0; i < 4; i += 1) {
    push({ label: `心跳上报 #${i + 1}`, service: 'ios', ts: base + 1500 + i * 8000, dur: 0 });
  }
  order(3000, 'ios', page % 3 === 0); // 每 3 段有一单网关 500,演示 statusOf
  feed(14000, 'h5');
  order(26000, 'ios');

  return foldTree(
    fromFlatSpans(raw, {
      id: 'spanId',
      parentId: 'parentSpanId',
      name: 'label',
      category: 'service',
      start: 'ts',
      duration: 'dur',
      origin: BASE // ← 固定 origin,跨段对齐的关键
    })
  );
}

function countSpans(nodes: TraceNode[]): number {
  let n = 0;
  for (const node of nodes) {
    n += 1;
    if (node.children) n += countSpans(node.children);
  }
  return n;
}

// ============================================================
const mount = document.getElementById('timeline') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const detail = document.getElementById('detail') as HTMLDivElement;

let nextPage = 0;
let pages = 0;
let spans = 0;
let loading = false;

/** 模拟接口延迟,便于观察加载动画 */
const sleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

function setStatus(text: string, busy = false): void {
  statusEl.textContent = text;
  statusEl.dataset.busy = busy ? '1' : '';
}
function summary(): string {
  return `已加载 ${pages} 段 · 共 ${spans.toLocaleString('en-US')} 条 span`;
}

const initial = makePage(nextPage++);
pages = 1;
spans = countSpans(initial);
setStatus(summary());

const tl = new Tracelane(mount, {
  data: initial,
  categories,
  theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  height: 360,
  initialView: [0, 30000], // 先看前 30s,往右拖即可触到本段末端
  colorOf: (node) => (node.meta?.error ? '#E24B4A' : undefined),
  statusOf: (node) => (Number(node.meta?.httpStatus) >= 500 ? 'error' : undefined),

  onSelect(node) {
    if (!node) {
      detail.style.display = 'none';
      return;
    }
    const cat = categories[node.category] ?? { label: node.category, color: '#888888' };
    const dur = node.kind === 'group' ? node.total : node.duration;
    detail.style.display = 'block';
    detail.innerHTML =
      `<div class="name"><span class="chip" style="background:${cat.color}"></span>${node.name}</div>` +
      `<div class="sub">类别:${cat.label} · 开始 T+${Math.round(node.start)} ms · 持续 ${Math.round(dur)} ms</div>`;
  },

  // 拖到末端或点刷新图标 → 模拟异步拉取下一段 → appendData 并入(无限滚动)
  onReachEdge(edge) {
    if (edge !== 'end' || loading) return;
    loading = true;
    setStatus('加载中…(模拟请求下一段)', true);
    // 真实接入这里换成 fetch(`/api/trace?after=${view[1]}`)
    void (async () => {
      await sleep(5000); // 模拟接口延迟,这段时间刷新图标会一直转
      const batch = makePage(nextPage++);
      tl.appendData(batch);
      pages += 1;
      spans += countSpans(batch);
      loading = false;
      setStatus(summary());
    })();
  }
});

void tl;

// 侧栏切换主题时同步组件
window.addEventListener('tl-theme', (e) => {
  tl.setTheme((e as CustomEvent<'light' | 'dark'>).detail);
});
