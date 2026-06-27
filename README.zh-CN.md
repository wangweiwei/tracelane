<p align="center"><a href="./README.md">English</a> | 简体中文</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/wangweiwei/tracelane/main/assets/logo.svg" alt="Tracelane logo —— 零依赖的 TypeScript + Canvas 库,把全链路 trace 渲染为可缩放的因果树瀑布" width="320" />
</p>

<p align="center">
  经线为时间,纬线为行为 —— 全链路行为时间线组件
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tracelane"><img src="https://img.shields.io/npm/v/tracelane?style=flat-square&color=378ADD" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/tracelane"><img src="https://img.shields.io/npm/dm/tracelane?style=flat-square" alt="npm downloads" /></a>
  <a href="https://bundlephobia.com/package/tracelane"><img src="https://img.shields.io/bundlephobia/minzip/tracelane?style=flat-square" alt="minzipped size" /></a>
  <a href="./package.json"><img src="https://img.shields.io/badge/dependencies-0-44cc11?style=flat-square" alt="zero dependencies" /></a>
  <img src="https://img.shields.io/npm/types/tracelane?style=flat-square" alt="types included" />
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/tracelane?style=flat-square&color=blue" alt="license MIT" /></a>
</p>

<p align="center">
  <a href="https://wangweiwei.github.io/tracelane/"><img src="https://img.shields.io/badge/%E5%9C%A8%E7%BA%BF%E6%BC%94%E7%A4%BA-378ADD?style=flat-square&logo=github&logoColor=white" alt="在线演示" /></a>
  <a href="https://stackblitz.com/github/wangweiwei/tracelane"><img src="https://img.shields.io/badge/Open_in_StackBlitz-1389FD?style=flat-square&logo=stackblitz&logoColor=white" alt="Open in StackBlitz" /></a>
</p>

## Tracelane 是什么?

**Tracelane 是一个零依赖、框架无关的 TypeScript 库,在 HTML Canvas 上把全链路用户行为 trace 渲染为可缩放、可折叠的因果树瀑布——每个 span 独占一行,缩进表达父子因果。** 它把"用户在什么时间、什么端、做了什么,引发了哪些下游网关、服务、存储行为、各持续多久"画成一条可交互的瀑布。

基于原生 Canvas 2D,零运行时依赖、随包发布 TypeScript 类型声明,在 React、Vue、Svelte 或原生 HTML 中表现一致——把 `Tracelane` 类挂到一个普通 DOM 元素上即可。面向全链路 trace、分布式追踪(distributed tracing)、用户行为链路、span 瀑布、可观测性 / APM 时间线视图而设计,MIT 协议。

## 特性

- **无限时间轴**:Ctrl/⌘ + 滚轮(或触摸板捏合)以光标为中心缩放,拖拽平移,底部全局缩略图(minimap)永远展示全貌并支持拖拽寻址
- **因果树瀑布**:每个行为独占一行,缩进表达父子因果(端 → 网关 → 服务 → 存储),点击行展开/收起
- **同类行为折叠**:`foldSiblings` 把"同类、连续、达到次数门槛"的重复行为(心跳、分页、批量 SQL)折叠为带 ×N 计数的聚合条,展示成员刻痕与累计/均值统计
- **虚拟行渲染**:只绘制可视区间内的行,行数增长不影响渲染开销
- **数据自由定制**:两条正交的「缝」——结构上 `fromFlatSpans` / `fromTree` 把任意来源(字段映射)收敛到内部模型;表现上 `colorOf` / `labelOf` / `shapeOf` / `statusOf` 在不动数据的前提下自由换色、改文案、画瞬时事件菱形、标错误状态
- **可定制**:类别颜色与文案(可选,未注册按内置 8 色调色板自动取色)、明暗主题(`theme: 'dark'` 或 `{ extends: 'dark', ...覆盖 }` 在预设上微调)、时间格式化、tooltip 渲染器均可注入;选中/展开/视口变化均有回调

## 安装

```bash
npm install tracelane
# 或
pnpm add tracelane
# 或
yarn add tracelane
```

## 快速开始

```ts
import { Tracelane, createSpan, foldSiblings } from 'tracelane';

const data = foldSiblings([
  createSpan('点击「提交订单」', 'ios', 0, 420, [
    createSpan('POST /api/order', 'gw', 60, 900, [
      createSpan('createOrder', 'svc', 130, 780, [
        createSpan('INSERT orders', 'db', 180, 110)
      ])
    ])
  ])
]);

const tl = new Tracelane(document.getElementById('timeline')!, {
  data,
  categories: {
    ios: { label: 'iOS 端', color: '#378ADD' },
    gw: { label: '网关', color: '#D4537E' },
    svc: { label: '服务', color: '#1D9E75' },
    db: { label: '存储', color: '#BA7517' }
  },
  onSelect(node) {
    console.log('selected', node);
  }
});
```

## 通过 CDN(无构建)

```html
<div id="timeline"></div>
<script src="https://unpkg.com/tracelane/dist/tracelane.umd.cjs"></script>
<script>
  const { Tracelane, createSpan, foldSiblings } = Tracelane;
  const data = foldSiblings([
    createSpan('点击「提交订单」', 'ios', 0, 420)
  ]);
  new Tracelane(document.getElementById('timeline'), { data });
</script>
```

UMD 全局 `Tracelane` 是承载全部具名导出的命名空间对象(类 `Tracelane`、`createSpan`、`foldSiblings` 等均从中解构)。亦可用 jsDelivr:`https://cdn.jsdelivr.net/npm/tracelane/dist/tracelane.umd.cjs`。

## 数据模型

时间单位统一为毫秒,`start` 为相对时间线原点(T+0)的偏移。接入真实数据时建议以服务端时钟为锚点换算,避免端云时钟偏差导致"响应早于请求"。

```ts
interface SpanNode {
  kind: 'span';
  id: string;            // 对应 spanId
  name: string;          // 展示名
  category: string;      // 类别 key,需在 categories 中注册
  start: number;         // 起点(ms)
  duration: number;      // 持续(ms)
  children?: TraceNode[]; // 因果子节点
  hasChildren?: boolean; // 「逻辑上有子节点」,懒加载时 children 未拉取仍画展开箭头;缺省由 children 推导
  meta?: Record<string, unknown>; // traceId / 用户 / 设备等,回调中原样带回
}

// GroupNode 复用 SpanNode 的全部公共字段(id/name/category/start/duration/children/meta),
// 额外多出 count 与 total
interface GroupNode {
  kind: 'group';
  count: number; // 成员数
  total: number; // 成员耗时之和(注意:duration 是首尾跨度,不是各成员之和)
  // ...以及 id / name / category / start / duration / children / meta
}
```

### 折叠工具

```ts
foldSiblings(children, {
  gap: 12000,   // 相邻重复最大空闲间隔,超过则切成两组
  minCount: 3,  // 连续重复达到该次数才折叠
  keyOf: (n) => `${n.category}|${n.name.replace(/\d+/g, '{n}')}` // 折叠键
});
foldTree(nodes, options); // 对整棵树逐层折叠
```

折叠键的归一化(URL/SQL 参数抽参)建议在埋点或服务端预计算并通过 `keyOf` 注入,客户端默认实现仅做数字归一。

## 数据接入

数据定制分两条正交的「缝」,可分别使用。

### 缝① 结构映射 —— 任意来源 → 规范树

后端 trace 多是**扁平 span 列表**(每条带 `parentId`、`start` 为绝对时钟)。`fromFlatSpans` 据此建因果树并锚定时间;字段既可传**字段名**也可传**函数**:

```ts
import { fromFlatSpans, foldTree } from 'tracelane';

const data = foldTree(
  fromFlatSpans(rawSpans, {
    id: 'spanId',
    parentId: 'parentSpanId',           // 空 / 父不存在 => 根
    name: (r) => `${r.method} ${r.route}`,
    category: (r) => r.service,         // 开放字符串,未注册类别会自动取色
    start: 'startUnixMs',               // 绝对时钟(epoch ms)
    duration: 'durationMs',
    origin: 'auto',                     // T+0 锚点:'auto'=min(start) | number | (rows)=>number
    meta: (r) => r                      // 原始行原样带回,默认即 r => r
  })
);
```

边界全部确定:**孤儿**(父不存在)提为根、**父子环**打断并降为根、**重复 id** 后者覆盖,均汇总一次 `console.warn`;各层按 `start` 升序。与折叠正交,需要折叠时在外层套 `foldTree`。

已是嵌套结构的数据用 `fromTree(roots, { children, ...同款字段 })`。想要稳定图例可用 `autoCategories(data)` 预生成 `categories`。

时间锚定归适配器独占:`origin:'auto'` 给相对视图;要墙钟轴标就传**显式服务端锚点**,再以 `formatTime(t + origin)` 还原,避免端云时钟偏差导致「响应早于请求」。

### 缝② 表现编码 —— 同一份数据换画法

下列钩子挂在 `TracelaneOptions` 上,全部可选、缺省退回现状、零破坏。入参是规范节点,`meta` 里就是你的原始行:

| 钩子 | 作用 | 缺省 |
| --- | --- | --- |
| `colorOf(node)` | 覆盖类别色(标签 / 色块 / 缩略图同步) | 返回 `undefined` 用类别色 |
| `labelOf(node)` | 左栏整行文案 | 折叠组带 `×N`,否则 `name` |
| `shapeOf(node)` | `'bar'` 时长条 / `'point'` 瞬时事件菱形 | `duration<=0` 判为 `point` |
| `statusOf(node)` | `'error'` / `'warn'` 行左缘 accent | 返回 `undefined` 不画 |

```ts
new Tracelane(el, {
  data,                                              // categories 可省,自动取色
  colorOf: (n) => (n.meta?.error ? '#E24B4A' : undefined),
  statusOf: (n) => (Number(n.meta?.httpStatus) >= 500 ? 'error' : undefined)
});
```

## API

| 方法 | 说明 |
| --- | --- |
| `new Tracelane(container, options)` | 挂载组件,见 `TracelaneOptions` 类型注释 |
| `setData(data, { keepView })` | 替换数据,`keepView` 为 true 时保留当前时间视口与滚动位置 |
| `appendData(nodes)` | 增量追加顶层节点并保留当前视口(配合 `onReachEdge` 做无限滚动);追加节点的 `start` 须与现有数据同一时间原点 |
| `setTheme(theme)` | 运行时切换主题(`'light'` / `'dark'` / 覆盖对象);数据 / 视口 / 展开 / 选中状态全部保留 |
| `setHiddenCategories(keys)` / `getHiddenCategories()` | 按类别过滤——隐藏给定类别的 span 连同其因果子树(空=全显示);缩略图同步过滤 |
| `zoomIn()` / `zoomOut()` / `zoomTo(t0, t1)` / `resetView()` / `getView()` | 时间视口控制 |
| `expand(id)` / `collapse(id)` / `collapseAll()` / `setExpanded(ids)` / `getExpanded()` | 展开状态控制 |
| `select(id \| null)` | 选中节点并触发 `onSelect` |
| `reveal(id)` | 展开祖先、滚动到该行、必要时平移时间视口并选中(用于搜索定位) |
| `destroy()` | 卸载并清理全部监听 |

回调:`onSelect(node)`、`onExpandChange(ids)`、`onViewChange([v0, v1])`、`onReachEdge(edge, [v0, v1])`(`edge` 为 `'start'` / `'end'`;传入即开启「滑动到边缘加载更多」,配合 `appendData` 做无限滚动)。

## 其他导出

除上述 API 外,包还导出:

- `createSpan` / `createGroup` —— 手搓节点。`createGroup(name, category, members, meta?)` 会自动计算 `start` / `duration` / `count` / `total`。
- `fromFlatSpans` / `fromTree` / `autoCategories` —— 结构映射适配器(详见「数据接入」)。
- `paletteColor(key)` 与 `CATEGORY_PALETTE` —— 从内置 8 色调色板取按键稳定的配色。
- `lightTheme` / `darkTheme` / `resolveTheme(input)` —— 构造完整的 `TracelaneTheme`。
- `formatTimeDefault(ms)` —— 默认时间格式化器。
- 全部 TypeScript 类型:`TraceNode` / `SpanNode` / `GroupNode` / `TraceNodeBase` / `CategoryStyle` / `TracelaneOptions` / `TracelaneTheme` / `ThemeOverride` / `ThemeInput` / `FoldOptions` / `NodeStatus` / `BarShape`,以及适配器类型 `Get` / `Origin` / `FlatMapping` / `TreeMapping`。

## 交互约定

| 操作 | 行为 |
| --- | --- |
| 滚轮 | 纵向滚动行 |
| Ctrl/⌘ + 滚轮(触摸板捏合) | 以光标为中心缩放时间 |
| Shift + 滚轮 | 时间轴横移 |
| 拖拽 | 横向平移时间 + 纵向滚动 |
| 点击有子节点的行 | 展开 / 收起 |
| 点击叶子行 | 选中,触发 `onSelect` |
| 缩略图按下 / 拖动 | 视口寻址 |

## 常见问题(FAQ)

### Tracelane 是什么?

Tracelane 是一个零依赖的 TypeScript 库,在 HTML Canvas 上把全链路 trace 与用户行为链路渲染为可缩放、可折叠的瀑布。每个 span / 行为独占一行,缩进表达父子因果(如 端 → 网关 → 服务 → 存储)。它经由 Canvas 2D 渲染,随包发布 TypeScript 类型,采用 MIT 协议。

### 它和火焰图(flamegraph)或甘特图(Gantt chart)有什么不同?

和火焰图、trace 甘特图一样,Tracelane 也在共享时间轴上把耗时映射为条宽。不同在布局与交互:它用「每个 span 独占一行」的因果树,缩进编码父子因果,点击行展开 / 收起;此外还有以光标为中心的无限缩放时间轴、底部缩略图、同类行为折叠(重复 span 折叠为 ×N 聚合条)以及虚拟渲染(只绘制可视行)。

### Tracelane 依赖 React 或 Vue 这类框架吗?

不依赖。它框架无关、零运行时依赖。你针对一个普通 DOM 元素实例化 `Tracelane` 类(`new Tracelane(container, options)`),因此在 React、Vue、Svelte 或原生 HTML 中表现一致。另提供 UMD 构建,可直接从 CDN 使用、无需任何构建步骤。

### 它能承载多大数据量?

渲染采用虚拟行——只绘制可视区间内的 span——因此纵向行数不影响每帧开销。截断后的标签与缩略图几何均有缓存,时间轴与数据深度无关。对很长的历史还支持「滑动到边缘加载更多」:视口贴到数据边缘时 `onReachEdge` 回调触发,你再用 `appendData` 增量并入新 span。

### 它能接 OpenTelemetry、Jaeger 或 Zipkin 的数据吗?

通过通用结构适配器,它能接任意扁平 span 列表或嵌套树。`fromFlatSpans` 接收带 `parentId` 与绝对时钟时间戳的行并建因果树(处理孤儿、环、重复 id),`fromTree` 接已嵌套的数据。你把自己的字段(传字段名或访问器函数)映射到 id / parentId / name / category / start / duration 即可。专用的 `fromOtel` / `fromJaeger` / `fromZipkin` 预设在 Roadmap 中、尚未发布——目前用 `fromFlatSpans` 映射这些格式。

### 怎么自定义颜色、文案、形状与状态?

通过两条正交的缝。结构适配器(`fromFlatSpans` / `fromTree` / `autoCategories`)把任意来源收敛到规范树。`TracelaneOptions` 上的表现钩子在不改动数据的前提下重新编码同一份数据:`colorOf(node)` 覆盖类别色,`labelOf(node)` 设定行文案,`shapeOf(node)` 选择时长条或瞬时事件菱形,`statusOf(node)` 在行左缘画 error / warn accent。类别也可以注册显式的文案与颜色,或从内置 8 色调色板自动分配。

### 可以在运行时切换明暗主题吗?

可以。在构造时传 `theme: 'light' | 'dark'` 或覆盖对象(`{ extends: 'dark', ...token 覆盖 }`),并在运行时调用 `setTheme(theme)` 切换——切换过程中数据、视口、展开、选中状态全部保留。

### 核心交互与公开 API 有哪些?

Ctrl/⌘ + 滚轮(或触摸板捏合)以光标为中心缩放时间轴,Shift + 滚轮横移时间,拖拽平移并滚动,底部缩略图寻址视口。公开 API 包括 `setData` / `appendData`、`setTheme`、`zoomIn` / `zoomOut` / `zoomTo` / `resetView` / `getView`、`expand` / `collapse` / `collapseAll` / `setExpanded` / `getExpanded`、`select(id)`、用于搜索定位的 `reveal(id)` 以及 `destroy()`,还有 `onSelect` / `onExpandChange` / `onViewChange` / `onReachEdge` 回调。

### Tracelane 是免费且开源的吗?

是。它采用 MIT 协议,可免费商用,以 `tracelane` 之名发布在 npm 上,零运行时依赖、随包发布 TypeScript 类型声明。

## 适用场景

- 把一次全链路用户行为 trace ——用户在什么时间、什么端做了什么,引发了哪些下游网关 / 服务 / 存储行为、各花多久——画成一条因果瀑布。
- 把分布式链路(带 `parentId` 的扁平 span,或嵌套树)当作可交互、可缩放的时间线来查看,而非一张静态图。
- 把高频重复 span(心跳、分页、批量 SQL)折叠为 ×N 聚合条,带成员刻痕与累计 / 均值统计,让密集链路依旧可读。
- 在 React、Vue 或原生 Web 应用里嵌入可观测性 / APM 时间线视图,而无需引入图表框架或运行时依赖。
- 用「滑动加载更多」浏览很长的行为历史,经 `onReachEdge` + `appendData` 在数据边缘增量追加新 span。
- 搜索定位场景:`reveal(id)` 展开祖先、滚动到该行、平移时间视口并选中匹配的 span。

## 为什么选 Tracelane

- **零运行时依赖、框架无关** —— 一个挂在 DOM 元素上的类,React / Vue / 原生通用,且有无需打包器的 UMD / CDN 构建。
- **因果树瀑布布局** —— 每个 span 独占一行,缩进编码父子因果、点击展开 / 收起,而非扁平或堆叠的时间线。
- **两条正交的定制缝** —— 结构适配器(`fromFlatSpans` / `fromTree` / `autoCategories`)接入任意来源,表现钩子(`colorOf` / `labelOf` / `shapeOf` / `statusOf`)在不改数据的前提下换样式。
- **同类行为折叠** —— `foldSiblings` / `foldTree` 把同类重复 span 折叠为 ×N 聚合条,对嘈杂的高频事件给出内置答案。
- **原生 Canvas 2D 底座** —— 虚拟行渲染、以光标为中心的无限缩放、底部缩略图、运行时明暗换肤,以及随包发布的 TypeScript 类型。

## 本地开发

```bash
pnpm install
pnpm dev        # 打开 demo(demo/ 目录)
pnpm typecheck  # 类型检查
pnpm build      # 产出 dist/(ESM + UMD + d.ts)
```

## Roadmap

数据接入是这个库对外可用的核心,优先做适配层:

- [x] `fromFlatSpans(rawSpans, mapping)` 通用扁平转树适配器(字段映射函数,把任意来源收敛到内部模型);`fromTree` 接已嵌套数据
- [ ] `fromOtel` / `fromJaeger` / `fromZipkin` 预设适配器(标准格式一行接入)
- [ ] 展开即加载:`childrenResolver` 异步按需下钻,配合 `hasChildren` 标记
- [ ] LOD 像素级聚合:span 不足 1px 时按密度条渲染
- [ ] 泳道(实体)视图作为次要模式,与瀑布视图一键切换
- [ ] 搜索 / 按耗时排序
- [ ] 触摸端手势(捏合缩放、双指平移)

## 许可证

[MIT](./LICENSE)
