/**
 * 共享左侧导航:三个 demo 页都 `import '/nav.ts'`(或 <script src="/nav.ts">)。
 * 固定侧栏 + 按当前路径高亮;新增 demo 只需往 DEMOS 里加一项。
 */
interface DemoLink {
  href: string;
  /** 侧栏与页头标题 */
  title: string;
  /** 侧栏二级说明(短) */
  desc: string;
  /** 页头描述(长,含关键用法) */
  sub: string;
}

const DEMOS: DemoLink[] = [
  {
    href: '/',
    title: '真实 demo',
    desc: '小数据 · 全功能展示',
    sub: '小数据 · 全功能展示。滚轮纵滚 · Ctrl/⌘+滚轮缩放 · Shift+滚轮横移 · 拖拽平移 · 点击行展开/收起;大规模性能见「性能基准」。'
  },
  {
    href: '/loadmore/',
    title: '滑动加载更多',
    desc: 'onReachEdge + appendData',
    sub: '<code>onReachEdge</code> + <code>appendData</code> 实现无限滚动。把时间视口<b>拖到最右端继续往右拖</b>,自动模拟请求并并入下一段;每段固定 origin 保证跨段对齐。'
  },
  {
    href: '/bench/',
    title: '性能基准',
    desc: '1万~200万 · 性能 HUD',
    sub: '1万~200万 span 压力测试。切规模后 hover/滚轮/拖拽看右上角 HUD 的 <b>FPS 与 worst 1s</b>;「全部展开」压虚拟化;拖到末端触发滑动加载更多。'
  }
];

/** 归一化路径以便比较:去掉 index.html 与末尾斜杠 */
function norm(path: string): string {
  return path.replace(/index\.html$/, '').replace(/\/+$/, '') || '/';
}

// —— 主题(亮/暗):持久化到 localStorage,切换时广播 'tl-theme' 事件给各 demo ——
type Theme = 'light' | 'dark';

function getTheme(): Theme {
  try {
    return localStorage.getItem('tl-theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
}

function syncToggleLabel(): void {
  const btn = document.getElementById('tl-theme-toggle');
  if (btn) btn.textContent = getTheme() === 'dark' ? '☀  亮色' : '☾  暗色';
}

function toggleTheme(): void {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem('tl-theme', next);
  } catch {
    /* 隐私模式等场景忽略 */
  }
  applyTheme(next);
  window.dispatchEvent(new CustomEvent<Theme>('tl-theme', { detail: next }));
  syncToggleLabel();
}

// 模块加载即应用(deferred module 顺序:本文件在各 demo main.ts 之前执行)
applyTheme(getTheme());

const MARK = `<svg viewBox="0 0 64 64" width="22" height="22" aria-hidden="true">
  <line x1="15" y1="14" x2="15" y2="50" stroke="#9AA1AC" stroke-width="2.5" stroke-linecap="round"/>
  <rect x="15" y="17" width="32" height="8" rx="4" fill="#378ADD"/>
  <rect x="23" y="29" width="24" height="8" rx="4" fill="#BA7517"/>
  <rect x="31" y="41" width="16" height="8" rx="4" fill="#1D9E75"/>
  <path d="M53 16 L58 21 L53 26 L48 21 Z" fill="#D4537E"/>
</svg>`;

function render(): void {
  const here = norm(window.location.pathname);

  const style = document.createElement('style');
  style.textContent = `
    body.tl-has-sidebar { padding-left: 208px; }
    /* 统一三个 demo 的内容区:同宽、左对齐紧跟侧栏(不再居中浮空),边距一致 */
    body.tl-has-sidebar .page { max-width: 1280px; margin: 0; padding: 28px 36px 64px; }
    .tl-sidebar { position: fixed; top: 0; left: 0; width: 208px; height: 100vh; box-sizing: border-box;
      padding: 18px 12px; border-right: 1px solid rgba(0,0,0,0.08); background: #fff; overflow-y: auto; z-index: 50; }
    .tl-brand { display: flex; align-items: center; gap: 8px; margin: 2px 6px 16px;
      font-size: 15px; font-weight: 600; letter-spacing: 0.01em; color: #1f1f1f; }
    .tl-nav-label { font-size: 11px; color: #9c9c9c; margin: 0 8px 6px; letter-spacing: 0.04em; }
    .tl-item { display: block; padding: 8px 10px; margin-bottom: 2px; border-radius: 8px;
      text-decoration: none; color: #1f1f1f; }
    .tl-item:hover { background: #f1f1ee; }
    .tl-item .t { display: block; font-size: 13.5px; }
    .tl-item .d { display: block; font-size: 11px; color: #9c9c9c; margin-top: 1px; }
    .tl-item.active { background: #eaf2fc; }
    .tl-item.active .t { color: #185FA5; font-weight: 600; }
    .tl-h1 { font-size: 20px; font-weight: 600; letter-spacing: 0.02em; margin: 0 0 6px; color: var(--text, #1f1f1f); }
    .tl-sub { font-size: 13px; line-height: 1.7; margin: 0 0 16px; color: var(--text-2, #6e6e6e); }
    .tl-sub b { color: var(--text, #1f1f1f); font-weight: 600; }
    .tl-sub code { font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
    .tl-toggle { display: block; width: 100%; margin-top: 12px; padding: 8px 10px; border-radius: 8px;
      border: 1px solid rgba(0,0,0,0.1); background: transparent; color: #1f1f1f; font: inherit; font-size: 13px;
      text-align: left; cursor: pointer; }
    .tl-toggle:hover { background: #f1f1ee; }
    /* —— 暗色:覆盖各 demo 共用的 CSS 变量 + 侧栏自身配色 —— */
    html[data-theme="dark"] {
      --text: #ececec; --text-2: #a8a8a8; --bg: #191a1d; --panel: #25262b; --border: rgba(255,255,255,0.10);
      color-scheme: dark;
    }
    html[data-theme="dark"] .tl-sidebar { background: #1b1c1f; border-right-color: rgba(255,255,255,0.08); }
    html[data-theme="dark"] .tl-brand { color: #ececec; }
    html[data-theme="dark"] .tl-item { color: #d4d4d4; }
    html[data-theme="dark"] .tl-item:hover { background: rgba(255,255,255,0.06); }
    html[data-theme="dark"] .tl-item.active { background: rgba(55,138,221,0.18); }
    html[data-theme="dark"] .tl-item.active .t { color: #5FA0E6; }
    html[data-theme="dark"] .tl-item .d, html[data-theme="dark"] .tl-nav-label { color: #7c7c7c; }
    html[data-theme="dark"] button { background: #25262b; color: #ececec; border-color: rgba(255,255,255,0.14); }
    html[data-theme="dark"] button:hover { background: #303137; }
    @media (max-width: 720px) {
      body.tl-has-sidebar { padding-left: 0; }
      .tl-sidebar { position: static; width: auto; height: auto; border-right: 0;
        border-bottom: 1px solid rgba(0,0,0,0.08); display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
      .tl-brand { margin: 0 12px 0 4px; }
      .tl-nav-label { display: none; }
      .tl-item { padding: 6px 10px; }
      .tl-item .d { display: none; }
    }
  `;
  document.head.appendChild(style);

  const items = DEMOS.map((d) => {
    const active = norm(d.href) === here ? ' active' : '';
    return `<a class="tl-item${active}" href="${d.href}"><span class="t">${d.title}</span><span class="d">${d.desc}</span></a>`;
  }).join('');

  const nav = document.createElement('nav');
  nav.className = 'tl-sidebar';
  nav.innerHTML =
    `<div class="tl-brand">${MARK}<span>Tracelane</span></div>` +
    `<div class="tl-nav-label">DEMO</div>` +
    items +
    `<button id="tl-theme-toggle" class="tl-toggle" type="button"></button>`;

  document.body.classList.add('tl-has-sidebar');
  document.body.insertBefore(nav, document.body.firstChild);

  syncToggleLabel();
  document.getElementById('tl-theme-toggle')?.addEventListener('click', toggleTheme);

  // 标准化页头(标题 = demo 名,描述统一风格):页面提供 <div id="page-head"></div> 即可
  const head = document.getElementById('page-head');
  const active = DEMOS.find((d) => norm(d.href) === here);
  if (head && active) {
    head.innerHTML = `<h1 class="tl-h1">${active.title}</h1><p class="tl-sub">${active.sub}</p>`;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', render);
} else {
  render();
}
