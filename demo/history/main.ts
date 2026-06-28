/**
 * tracelane · 绝对时间轴 + 向后加载历史 demo
 * ------------------------------------------------------------------
 * 两件事一起演示:
 *  1. 绝对(墙钟)时间轴:axis:'auto' + originEpoch。宽视野显示 YYYY-MM-DD HH:mm:ss
 *     (跨天有日期 chip),放大到单条 trace 自动切回时段。
 *  2. 向后加载历史(Phase 3):backfill:true。把视口拖到**最左端继续往左拖**(或点左缘
 *     图标),触发 onReachEdge('start'),模拟拉取更早一段并 appendData 前插。更旧数据
 *     offset 为负;并入后用「基于时间的锚点」保持视口中心行不跳动。拉够若干段后
 *     setEdgeExhausted('start') 收掉提示,表示到头。
 *
 * 关键:所有段共用同一个固定 origin(BASE),保证跨段坐标对齐;origin 同时作为
 * 构造器 originEpoch,让轴把 offset 还原成墙钟。
 * ------------------------------------------------------------------
 */
import {
  Tracelane,
  fromFlatSpans,
  foldTree,
  resolveOrigin,
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

const BASE = Date.UTC(2026, 5, 27, 9, 0, 0); // 固定服务端时钟锚点 = origin
const SPAN = 300_000; // 每段约 5 分钟
const MAX_OLDER = 3; // 最多向后加载 3 段,之后置为「到头」

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

let batchSeq = 0;
/** 造一段铺在 [baseTs, baseTs+SPAN] 的真实 trace(绝对时钟);id 带 batch 前缀避免跨段重复 */
function makeRaw(baseTs: number, fail = false): RawSpan[] {
  const raw: RawSpan[] = [];
  const tag = `b${(batchSeq += 1)}`;
  let seq = 0;
  const push = (s: Omit<RawSpan, 'spanId'>): string => {
    const spanId = `${tag}_${(seq += 1)}`;
    raw.push({ ...s, spanId });
    return spanId;
  };

  const order = (t: number, client: 'ios' | 'h5', f = false): void => {
    const root = push({ label: '点击「提交订单」', service: client, ts: baseTs + t, dur: 420 });
    const gw = push({ parentSpanId: root, label: 'POST /api/order', service: 'gw', ts: baseTs + t + 60, dur: f ? 1300 : 900, httpStatus: f ? 500 : 200, error: f });
    const co = push({ parentSpanId: gw, label: 'createOrder 业务处理', service: 'svc', ts: baseTs + t + 130, dur: 780 });
    push({ parentSpanId: co, label: 'INSERT orders', service: 'db', ts: baseTs + t + 180, dur: 110 });
    for (let i = 0; i < 4; i += 1) {
      push({ parentSpanId: co, label: `INSERT order_items #${i + 1}`, service: 'db', ts: baseTs + t + 300 + i * 70, dur: 45 });
    }
    push({ parentSpanId: co, label: '创建支付单', service: 'svc', ts: baseTs + t + 720, dur: 260 });
    push({ parentSpanId: root, label: '渲染收银台', service: client, ts: baseTs + t + 1100, dur: 380 });
  };

  const feed = (t: number, client: 'ios' | 'h5'): void => {
    const root = push({ label: '滑动浏览商品流', service: client, ts: baseTs + t, dur: 300 });
    for (let i = 0; i < 6; i += 1) {
      const g = push({ parentSpanId: root, label: `GET /api/feed?page=${i + 1}`, service: 'gw', ts: baseTs + t + 150 + i * 420, dur: 150, httpStatus: 200 });
      push({ parentSpanId: g, label: `查询推荐 page=${i + 1}`, service: 'svc', ts: baseTs + t + 190 + i * 420, dur: 90 });
    }
    for (let i = 0; i < 8; i += 1) {
      push({ parentSpanId: root, label: `加载图片 img_${i + 1}`, service: client, ts: baseTs + t + 600 + i * 260, dur: 120 });
    }
  };

  push({ label: '首屏渲染完成', service: 'ios', ts: baseTs + 200, dur: 0 });
  for (let i = 0; i < 14; i += 1) {
    push({ label: `心跳上报 #${i + 1}`, service: 'ios', ts: baseTs + 1000 + i * 20_000, dur: 0 });
  }
  order(3_000, 'ios', fail);
  feed(60_000, 'h5');
  order(140_000, 'ios');
  feed(220_000, 'h5');

  return raw;
}

const origin = resolveOrigin(makeRaw(BASE), { start: 'ts', origin: BASE });
batchSeq = 0; // 复位:上面那次仅为算 origin

/** 把一段原始 span 收敛成规范折叠树(所有段共用 origin) */
function batch(baseTs: number, fail = false): TraceNode[] {
  return foldTree(
    fromFlatSpans(makeRaw(baseTs, fail), {
      id: 'spanId',
      parentId: 'parentSpanId',
      name: 'label',
      category: 'service',
      start: 'ts',
      duration: 'dur',
      origin
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

const mount = document.getElementById('timeline') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const detail = document.getElementById('detail') as HTMLDivElement;
const tzBtn = document.getElementById('tz') as HTMLButtonElement;
const liveBadge = document.getElementById('live-badge') as HTMLElement;

let tz: 'local' | 'utc' = 'local';
let olderLoaded = 0; // 已向后加载的段数
let newerLoaded = 0;
let spans = 0;
let loading = false;

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}
function fmtAbs(d: Date): string {
  const g = tz === 'utc'
    ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
    : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
  const [Y, Mo, D, h, m, s] = g;
  return `${Y}-${pad(Mo)}-${pad(D)} ${pad(h)}:${pad(m)}:${pad(s)}`;
}
const sleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

function setStatus(text: string, busy = false): void {
  statusEl.textContent = text;
  statusEl.dataset.busy = busy ? '1' : '';
}
function summary(): string {
  const earliest = BASE - olderLoaded * SPAN;
  // spans 为累计加载量;实际保留受 maxNodes 上限淘汰(向后拉时丢最新端整支)
  return `累计 ${olderLoaded + 1 + newerLoaded} 段 / ${spans.toLocaleString('en-US')} span(保留≤200 节点,超出淘汰远端) · 最早 ${fmtAbs(new Date(earliest))} (${tz}) · 拖左缘加载更早`;
}

const initial = batch(BASE);
spans = countSpans(initial);

let tl: Tracelane;

function build(): void {
  tl = new Tracelane(mount, {
    data: initial,
    categories,
    theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
    height: 360,
    axis: 'auto',
    originEpoch: origin,
    timezone: tz,
    backfill: true, // ← 开启向后加载:左缘出现加载图标
    maxNodes: 200, // ← 保留上限:向后拉时丢最新端整支,滑动窗口式浏览历史(span 数会见顶)
    initialView: [0, SPAN], // 起步即在最早一段,往左拖即可加载更早
    onLiveChange(live) {
      // 实时/历史徽标:进入 live 高亮闪烁,手动平移/缩放自动回到「历史」
      liveBadge.dataset.live = live ? '1' : '0';
      liveBadge.textContent = live ? 'Live' : '历史';
    },
    colorOf: (node) => (node.meta?.error ? '#E24B4A' : undefined),
    statusOf: (node) => (Number(node.meta?.httpStatus) >= 500 ? 'error' : undefined),

    onSelect(node) {
      if (!node) {
        detail.style.display = 'none';
        return;
      }
      const cat = categories[node.category] ?? { label: node.category, color: '#888888' };
      const dur = node.kind === 'group' ? node.total : node.duration;
      const abs = tl.dateOf(node.start);
      detail.style.display = 'block';
      detail.innerHTML =
        `<div class="name"><span class="chip" style="background:${cat.color}"></span>${node.name}</div>` +
        `<div class="sub">类别:${cat.label} · 持续 ${Math.round(dur)} ms` +
        (abs ? ` · 绝对时刻 <span class="abs">${fmtAbs(abs)}</span>` : '') +
        `</div>`;
    },

    // 拖到起点(左缘)→ 加载更早一段并前插;拖到末端 → 加载更晚一段
    onReachEdge(edge) {
      if (loading) return;
      if (edge === 'start') {
        loading = true;
        setStatus('加载更早历史…', true);
        void (async () => {
          await sleep(1200); // 模拟接口延迟,左缘图标旋转
          if (olderLoaded >= MAX_OLDER) {
            // 真实「到头」流:后端返回空批次 → 不 appendData,只标记到头。
            // 此时无 setData 收尾,组件由 setEdgeExhausted 负责停掉在转的左缘图标。
            tl.setEdgeExhausted('start');
            loading = false;
            setStatus(`${summary()} · 已到最早`);
            return;
          }
          olderLoaded += 1;
          const older = batch(BASE - olderLoaded * SPAN);
          tl.appendData(older); // 前插:offset 为负;内部时间锚点保证不跳动
          spans += countSpans(older);
          loading = false;
          setStatus(summary());
        })();
      } else {
        loading = true;
        setStatus('加载更晚数据…', true);
        void (async () => {
          await sleep(1200);
          newerLoaded += 1;
          const newer = batch(BASE + (newerLoaded) * SPAN, newerLoaded % 2 === 0);
          tl.appendData(newer);
          spans += countSpans(newer);
          loading = false;
          setStatus(summary());
        })();
      }
    }
  });
}

build();
setStatus(summary());

document.getElementById('jump-now')?.addEventListener('click', () => tl.jumpToNow()); // 回到当下 + 进入 live
// 模拟实时:在末端追加一段更新的数据。live 时视口自动跟随到最新;历史态则不动(锚点保持)
document.getElementById('push')?.addEventListener('click', () => {
  newerLoaded += 1;
  const newer = batch(BASE + newerLoaded * SPAN, newerLoaded % 2 === 0);
  tl.appendData(newer);
  spans += countSpans(newer);
  setStatus(summary());
});
document.getElementById('view-all')?.addEventListener('click', () => {
  tl.zoomTo(BASE - olderLoaded * SPAN - origin, SPAN + newerLoaded * SPAN); // 全貌(墙钟)
});
document.getElementById('view-zoom')?.addEventListener('click', () => {
  tl.zoomTo(2_500, 8_000); // 放大到首条 trace → 切回时段
});
tzBtn.addEventListener('click', () => {
  tz = tz === 'local' ? 'utc' : 'local';
  tzBtn.textContent = `时区:${tz}`;
  tl.destroy();
  build();
  setStatus(summary());
});

window.addEventListener('tl-theme', (e) => {
  tl.setTheme((e as CustomEvent<'light' | 'dark'>).detail);
});
