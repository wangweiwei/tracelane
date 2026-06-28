# 设计文档：双向时间轴（历史回溯 + 实时增量）

状态：草案 / 待评审
作者：设计讨论产物（多方案评审 + 对抗审查综合）
日期：2026-06

---

## 1. 背景与目标

当前时间轴只表达**相对 T+0 的时段**（`0 ms` / `2.00 s` / `4.00 s`），适合「单条 trace 往后增长」的场景。但有第二类需求无法满足：

- **向前加载旧数据（历史回溯）**：拖到左缘 → `onReachEdge('start')` → 前插。历史数据**量大**。浏览历史时刻度应显示**绝对墙钟时间**，而不是越来越大的负时段。
- **向后实时绘制新数据**：新 span 缓慢追加到右侧，**仍用时段**轴最自然。

目标：同一个视图，往左滚进历史显示绝对时间、往右回到实时显示时段，**两端可并存**。

## 2. 已锁定的决策

| 决策 | 选择 |
|---|---|
| 轴标签模式 | `axis: 'auto'`：滚进历史/视野变宽自动变绝对，滚回实时变回时段（默认 option 仍 `elapsed`，老用户零变化） |
| 绝对刻度文案 | **按粒度分级**：跨天那格显示日期 chip，格内显示 `HH:mm:ss`，完整 `YYYY-MM-DD HH:mm:ss` 进 tooltip |
| 历史保留策略 | **默认无上限**；`maxNodes` 作为一等可选开关 |
| 本轮交付 | 书面设计文档（本文件） |

## 3. 核心架构：单坐标，双面（single coordinate, two faces）

**不分叉数据。** 内部坐标永远是「相对固定 origin 的 offset(ms)」。绝对/时段只是**渲染刻度时每帧的标签选择**，数据与坐标不变。

- 新增不可变字段 `originEpoch: number`（offset 0 对应的墙钟时刻）。绝对时间仅在**画标签**处换算 `new Date(originEpoch + offset)`，不进像素计算、不逐节点存。
- **为什么坚持存 offset 而非 epoch**：`xOf` 里 `(t - v0)/(v1 - v0)`（`src/core/tracelane.ts` 的 `xOf`，约 :509），epoch 量级 ~1.7e12 在亚秒缩放（`MIN_WINDOW_MS=20`）下会灾难性抵消、刻度抖动；offset 靠近 0 时浮点精度满格。
  - 注意：深度历史（如一年前）offset 约 -3e10，量级又变大，亚秒缩放会重新接近抵消区——因此**刻度迭代必须用索引/Date 步进**（见 §5），不能 `t += step` 累加。
- **`formatAxis`（墙钟刻度）与现有 `formatTime`（时长 / tooltip / bar 后缀）分开**。绝不拓宽 `formatTime` 的 `(ms)=>string` 契约（`src/types.ts` 约 :129）。bar 后缀和 tooltip 永远走 `formatTime`，于是「时长」与「墙钟刻度」可在同屏共存。

## 4. 轴模式 `auto`（含滞回，防接缝抖动）

每次 `render()` 解析出单个布尔 `axisIsAbsolute`：

```
axisIsAbsolute = originEpoch != null && (v0 < 0  ||  span >= autoAbsoluteThresholdMs)
```

- `autoAbsoluteThresholdMs` 默认 `60_000`。
- `originEpoch == null` 时永远 elapsed（绝对模式缺锚点 → 回退 elapsed + `console.warn` 一次）。

**对抗审查发现的坑：两个触发都要滞回，否则在 offset 0 接缝处每帧翻转。**

- `span` 阈值：±20% 滞回带（≥72s 才进绝对，≤48s 才退回）。
- `v0 < 0` 接缝：这是「历史与第一批的交界」，用户最容易停在这里。用**带死区的闩锁**：`v0 < -band` 才进绝对，`v0 > +band` 才退回（`band` 取若干像素对应的时间）。一旦因进入历史而锁定绝对，保持到明确回到纯未来区才解除。

bar 在换脸时**一个像素都不动**（坐标没变，只有网格锚点和标签字符串变）。

## 5. 绝对刻度生成（新模块 `src/core/timeScale.ts`，零依赖）

仅当 `axisIsAbsolute` 时调用。`niceStep`（`src/utils.ts:8`）**保持不动**，继续服务 elapsed 模式——纯增量、不动共享设施。

### 5.1 `pickCalendarStep(spanMs, targetTicks, tz) -> { stepMs, unit, every }`

按有序阶梯取「像素间距 ≥ ~85px」的最小一档（复用 `render()` 里 `(W - labelWidth)/85` 的目标刻度数，约 :578）：

```
ms:    1, 2, 5, 10, 20, 50, 100, 200, 500
s:     1, 2, 5, 10, 15, 30
min:   1, 2, 5, 10, 15, 30
hour:  1, 2, 3, 6, 12
day:   1, 2, 7, 14
month: 1, 3, 6
year:  1
```

### 5.2 `calendarTicks(absStart, absEnd, step, tz) -> { abs, offset, isDayBoundary, unit }[]`

- **sub-day 档（ms/s/min/hour）**：首刻度**对齐到本地时区边界**（整分/整点，不是 epoch-0/UTC，否则网格线不在整点上）。
  - **DST 修正（对抗审查发现）**：不能用 `anchorAbs + i*stepMs` 固定毫秒累乘——跨 DST 切换会漂成 `:30` 而非 `:00`。sub-day 也按**真实 Date 步进**（在 tz 下 `setMinutes/ setHours`），用整数计数避免浮点累加漂移。
- **day/month/year 档**：用真实 `Date` 的 `setDate/setMonth/setFullYear`（在 tz 下），DST 与月长天然正确。
- 每个 tick：`offset = abs - originEpoch`，喂进**现有 `xOf`（不改）**。替换 `render()` 里 `Math.ceil(v0/step)*step` + `t += step`（约 :580）——**仅绝对模式分支**。
- 跨 DST「回拨」那小时，墙钟标签等值但 epoch 不等距 → 像素间距不均，**这是正确的**。

### 5.3 标签（粒度分级）

| 粒度 | 格内标签 |
|---|---|
| sub-second | `HH:mm:ss.SSS` |
| sub-minute | `HH:mm:ss` |
| sub-day | `HH:mm` |
| ≥1 天 | `MM-DD` / `YYYY-MM-DD` |

- **日期 chip**：每个本地日的第一格用 `theme.textSecondary` 描一个加粗日期（如 `Jun 27` / `06-27`），格内仍 `HH:mm:ss`。
- **tooltip 永远给完整 `YYYY-MM-DD HH:mm:ss`**。
- **`AXIS_H` 保持 22、单行**。明确**否决**「绝对模式改成双行 date+time 带（per-mode `AXIS_H`）」——`AXIS_H` 被约 12 处读取（网格顶 :584、clip :594/827、行 y :774、视口高 :403/470、minimap、命中测试 :986/1052），改成 per-mode 可变是虚拟化/命中测试的正确性隐患。

### 5.4 性能

`Intl.DateTimeFormat`（带 IANA tz）逐 tick 逐帧调用很贵。**按 `(stepMs, unit, tz)` 记忆化 formatter，并对标签字符串做缓存**（类比现有 `labelCache`）。

## 6. 坐标 / origin 跨批对齐

- 不改 `fromFlatSpans` / `fromTree` 的 `TraceNode[]` 返回类型（它们在公开导出面 `src/index.ts`，改成 `{nodes, origin}` 是破坏性变更）。
- **新增导出 `resolveOrigin(rows, mapping) -> number`**，并让 `fromFlatSpans/fromTree` 接受并回显一个显式 `origin`。调用方**先定一个固定 epoch**，把它同时传给每一批的 `origin` 和构造器的 `originEpoch`。
- 前向批 offset 变大，后向批 offset 为**负**——都精确。
- 新方法：`getOriginEpoch(): number | undefined`、`epochOf(offset)`、`dateOf(offset)`。
  - **契约**：`originEpoch` 未设（elapsed 默认）时，`epochOf/dateOf` 返回 `undefined`（不要返回 `NaN` 的 Date）。

## 7. 向后加载交互

### 7.1 显式开关，别从 `onReachEdge` 推断（对抗审查发现的回归）

`onReachEdge` 是两端共用的单一回调（`src/types.ts:158`）。**不能**用「是否传了 onReachEdge」来放宽左侧 clampView——只接了 `end` 的现有 demo 会被允许左越界、空转 spinner。

→ 新增显式开关 **`backfill?: boolean`**（或 `loadEdges?: ('start'|'end')[]`）。仅当显式开启才放宽左缘。

### 7.2 放宽 `clampView`（约 :477-486）

当前 `start = clamp(v0, e0, e1-span)` 对向后加载敌对。`backfill` 开启时允许 `v0` 在 `e0` 之下有界越界（约一个 span，或到 `'start'` 触发为止）；未开启则保持硬 clamp（**零行为变化**）。约 :480-481 的「负刻度」顾虑在绝对模式下本就是真实过去、无意义。

### 7.3 左缘镜像现有右缘子系统

- `startHintVisible()`（`v0 - extent[0] <= eps`）、`startHintCenter()`（`cx = labelWidth + 18`）、`startHintHit()`
- `drawEdgeHints` 加左分支（镜像翻转的刷新图标）
- `maybeReachEdge`（约 :492-505）加 `'start'` 分支，调 `startSpin()`——**修掉现状只有 `'end'` 转图标的静默 bug**
- `handleWindowMouseUp` 加 `'start'` 可点击分支（镜像 :1045-1050）

**去重（对抗审查发现的双触发）**：现有 `'end'` 在 `maybeReachEdge`(:503) 和 `handleWindowMouseUp`(:1048) 都 `startSpin`，且点击分支 :1045-1050 直接置 `reachedEdge='end'` 不先检查。镜像到 `'start'` 时要**统一去重**：点击路径也走 `reachedEdge` 闩锁判断，避免「拖过缘 + 在图标上松手」双发回调。

### 7.4 露出新数据

`setData` 现仅记 `prevEnd`(:209) 并在 `pendingPanToEnd && extent[1] > prevEnd` 露出(:225-229)。对称加：记 `prevStart = extent[0]`，`pendingPanToStart && extent[0] < prevStart` 时 `v1 = prevStart + span*0.15; v0 = v1 - span`，让约 15% 新历史从左侧探入。

**再触发循环（对抗审查发现）**：露出后 v0 停在新左缘附近，下一个滚轮 tick 可能立刻再触发 `'start'`。缓解：露出落点离边缘留出 > eps 的余量；并要求调用方持 in-flight `loading` 标志（与现有 end 路径一致）。

**到头检测**：host 的 `onReachEdge('start')` 处理器若拉回**空批次**，即表示该侧无更多历史，调 `setEdgeExhausted('start')`（§8.4）——既收掉「还能拖」提示，也可作为停止继续触发的依据。若日后又拿到更早数据，用 `setEdgeExhausted('start', false)` 重新武装。

### 7.5 无跳动锚点 —— 改为「基于时间」而非行 id（最关键的修正）

**对抗审查的最致命发现**：原方案锚点记「视口中心行的 `node.id`」，prepend 后重定位。但：
- 折叠组 id 来自 `createGroup` 的 `uid('g')`（`src/data/factory.ts:20` + `src/utils.ts:58-62`），**每次 fold 都重新生成、非确定**；
- 「一个 span 是独立行还是被并进组」取决于它在**批内的邻居**（`src/data/fold.ts:52-61` 的 `[...rest, ...groups].sort()`）。

历史大数据恰恰全是折叠行（心跳 / 分页 / 批量 SQL）→ 锚点 id `findIndex` 返回 -1 → 退化成它声称要修的那个瞬移 bug。

**解法：锚点记「时间 offset」（一个数字），fold 不变量。** 在任何 `keepView` 的 `setData` 合并**之前**：

```
oldCenterIdx = floor((scrollY + viewportH/2) / rowHeight)
anchorOffset = rows[oldCenterIdx]?.node.start   // start 由数据时间派生,跨重折叠稳定
```

合并 + 重新 flatten **之后**：

```
newIdx  = 最接近 anchorOffset 的可见行下标 (按 node.start 二分/就近)
scrollY = scrollY + (newIdx - oldCenterIdx) * rowHeight
clampScroll()
```

- `anchorOffset` 是数值，与组 id、组成员归属无关 → 折叠数据也稳。
- 锚点行若重折叠后落进了折叠父、不可见：就近匹配仍落到最近的可见行，**不瞬移**（最坏轻微偏移，可接受）。
- 前向（实时）批排到底部 / 右侧，`newIdx == oldCenterIdx`，公式自动 no-op，无需特判。

## 8. minimap：纵向稳定性 + `totalDomain` + 降级链

### 8.1 纵向稳定性

minimap 的 y = `3 + (orderIdx/totalCount)*(mh-8)`（`src/core/minimap.ts:94-95`），`orderIdx` 是全局 DFS 序（`src/core/tree.ts:39-41`），**prepend 后人人重新编号** → 整个缩略图上下错位，违反「什么都不动」。

**决策（务实）**：主画布 bar 像素稳定是硬保证；**minimap 在加载历史时合理地整体重绘**（它本就是缩略图，且确实多了历史数据）。先**接受 minimap 重排**，不为它过度工程化。

### 8.2 `totalDomain`：把「minimap 显示域」从「数据 extent」拆出来

问题：minimap 的 x 当前映射 `extent`（已加载数据的 min/max）。向后无限加载时 extent 不断变宽 → 每次加载都把已看过的部分重新压扁，且永远看不出「外面还有多少没加载」。

`totalDomain?: [number, number] | (() => [number, number])` = 接入方告知的「整条时间线已知总域」，与「已加载的那段」解耦。minimap 据此把**已加载段画成亮色子区**，两侧未加载部分画成暗色**肩部**（左=更旧历史，右=未来），总域不变 → 已加载段位置稳定，一眼看清「在整条时间线的位置 + 左右还剩多少」。函数形式支持总域随时间生长（实时端右界=now）。

与已有 `timeExtent` 的区别（**勿混淆**）：`timeExtent` 把 `this.extent` 写死成常量，一处管三件事（minimap 域 + clamp 域 + 边缘检测域），会废掉增量加载（见 §9）。`totalDomain` **只改 minimap 显示域**，不碰 clamp / 边缘检测，与增量加载共存。

### 8.3 语义决策：`totalDomain` 是纯显示，还是权威可导航域

三处读 `this.extent`：minimap x 映射、`clampView`(:478)、`maybeReachEdge`(:494)。`totalDomain` 只改第一处时，会出现「minimap 画了大总域、但拖不进暗色肩部、加载仍在已加载缘触发」。

- **方案 A（推荐 v1）— 纯显示**：肩部只是「外面还有」的视觉提示；clamp / 边缘触发 / minimap 点击寻址**仍按已加载 extent**。导航模型不变（拖到已加载缘→触发加载→数据进来→继续），零新回调，与 `onReachEdge` 契合。代价：不能点肩部直接跳到很远的未加载时刻。
- **方案 B — 权威可导航域**：clamp 到总域、可拖/点进未加载区、边缘检测对总域、点肩部直接跳。代价大：需要一个**按任意区间加载**的新回调 `loadRange(t0,t1)`（远大于 `onReachEdge`），并要处理「跳到空白、数据未到」的中间态。

**v1 走 A**；B 的「任意时刻跳转 + ranged load」留作后续独立能力。

### 8.4 降级链：拿不到精确总域也不影响核心结果

`totalDomain` 是**有则更好的增强，不是前置依赖**。不传它：绝对轴、向后加载、无跳动锚点、数据正确性、clamp、边缘触发**全部不受影响**（它们用「已加载 extent」，永远已知）；**只有 minimap 退回今天的 fit-to-extent**（不比现在差）。

且总域**不必提前知道，可边走边学**——getter 每帧返回当前已知边界，按能拿到的信息分四档降级：

| 能提供的 | minimap 能做到 | 来源 |
|---|---|---|
| 精确总域 `[t0,t1]` | 完整：亮区 + 按比例肩部 | 后端有「最早/最晚」廉价查询 |
| 渐宽 getter | 近似：肩部随了解到的范围生长 | 分页游标 / 响应里的「还有更早=X」元信息 |
| **仅「到头」布尔** | 只显示「这侧还有更多」提示（渐隐/箭头），不画按比例肩部 | host 在拉到**空批次**时即知「到头」 |
| 啥都没有 | 退回 fit-to-extent（今天的行为） | —— |

**轻量信号 `setEdgeExhausted(edge: 'start'|'end', exhausted = true)`**（配套 §7，Phase 3 顺手带）：默认假设「`backfill` 开着且未到头 → 这侧可能还有」，于是 minimap 该侧给「还能拖」的提示；host 拉到空批次就调 `setEdgeExhausted('start')` 收掉提示。**连总域都不用**就解决了「看不出外面还有没有」的主要痛点。

本质限制（诚实）：若对历史规模一无所知、也无法说「可能还有」，minimap 画不出「按比例的全局定位」——这是信息本身不存在，非设计缺陷；代价仅止于此，加载/轴/数据全不受影响。

`totalDomain` 整体列入 **Phase 4**；`setEdgeExhausted` 提示列入 **Phase 3**。

## 9. timeExtent 冲突（对抗审查发现）

`extentFromOptions`（`src/core/tracelane.ts:131`）令 `extent` 恒定（:212）→ `prevEnd/prevStart` 永不变 → 露出分支永不触发；`maybeReachEdge` 对着固定 `[e0,e1]` 比较（:494）→ 边缘在错误位置触发或不触发。

**决策**：`backfill` 开启时**忽略/禁用** `timeExtent`（extent 从数据派生，随加载增长）。或显式文档化「timeExtent 与增量加载互斥」。注意 `timeExtent`（写死 extent）与 §8 的 `totalDomain`（只改 minimap 显示域）是**两件不同的事**，不要互相替代。

## 10. 跨批折叠接缝

每批由 host 各自 `foldTree`（如 demo `demo/main.ts` 约 :108）。前插不会跨接缝合并同类组（心跳被页边切断），任何「O(N) 前插」产出 ≠「整体重排序 + 重折叠」。

**决策**：保持 `appendData` 现有的 concat + sort 语义，**不引入会改变可见产出的 O(N) 前插优化**；明确文档化「折叠按批进行、接缝不合并」。若 host 要干净接缝，自行对合并集重折叠（成本自负）。

## 11. 时钟偏移说明

`resolveOrigin` 默认取首批 `min(start)`。若各服务时钟不一致，所有绝对标签会被全局偏移。文档建议：**多服务 trace 用统一服务端时钟锚定 origin**（与现有 `appendData` 文档「跨段用固定 origin」一致）。`originEpoch` 不可变是「无横向跳动」的前提，不提供运行时改 origin。

## 12. API 形状（全部可选、纯增量 → 现有用户零变化）

```ts
interface TracelaneOptions {
  // ... 现有
  axis?: 'elapsed' | 'absolute' | 'auto';        // 默认 'elapsed'
  originEpoch?: number;                            // offset 0 的墙钟 ms;不可变
  timezone?: string;                              // IANA,默认 local;via Intl,零依赖
  formatAxis?: (epochMs: number, ctx: {
    unit: 'ms'|'s'|'min'|'hour'|'day'|'month'|'year';
    stepMs: number; isDayBoundary: boolean;
  }) => string;                                    // 默认 formatAxisDefault;独立于 formatTime
  autoAbsoluteThresholdMs?: number;               // 默认 60000
  backfill?: boolean;                             // 显式开启向后加载(放宽左缘)
  maxNodes?: number;                              // 默认 undefined=无上限
  totalDomain?: [number, number] | (() => [number, number]); // 可选,Phase 4
}

// 方法(新增)
getOriginEpoch(): number | undefined;
epochOf(offset: number): number | undefined;
dateOf(offset: number): Date | undefined;
setEdgeExhausted(edge: 'start' | 'end', exhausted?: boolean): void; // 该侧到头;收掉"还有更多"提示(§8.4)

// 复用(签名不变)
appendData(nodes);                 // 现可前插;内部做时间锚点 + pendingPanToStart
onReachEdge('start' | 'end', view); // 'start' 终于有 UI

// 新导出(增量)
resolveOrigin(rows, mapping): number;
// utils: pickCalendarStep, formatAxisDefault (niceStep 不动)
// adapter: fromFlatSpans/fromTree 增加可选 origin 入参,返回类型不变
```

`formatTime` **保持** `(ms)=>string`，仍是时长/tooltip/bar 后缀的格式化器，不拓宽。

## 13. 分阶段实施

1. **Phase 1 — origin 管线（零视觉变化）✅ 已完成**：加不可变 `originEpoch` 字段 + 选项、`getOriginEpoch/epochOf/dateOf`（无 origin 时返回 `undefined`）；`resolveOrigin` 改为公开 mapping 形式并导出（`fromFlatSpans/fromTree` 已支持 `mapping.origin`，调用方据此跨批用固定 origin）；更新数据模型文档与 `clampView` 注释里的 T+0 措辞。`axis` 仍默认 elapsed → 零行为变化。typecheck / build / build:demo 均通过。
2. **Phase 2 — 绝对轴渲染（仅前向，先不做向后）✅ 已完成**：新增 `src/core/timeScale.ts`（`pickCalendarStep` + `calendarTicks` + `formatAxisDefault`，sub-day 也用真实 Date 步进 → DST 安全，day/month/year 用 Date 运算）；加 `axis`/`timezone`/`autoAbsoluteThresholdMs`/`formatAxis` 选项与 `resolveAxisAbsolute()` 解析（span ±20% 滞回 + v0<0 接缝死区）；`drawTimeAxis()` 分支（绝对走日历刻度 + 日界加粗日期 chip，elapsed 走原 `niceStep`+`formatTime`）；`niceStep`/`formatTime` 未动。`timezone` 当前支持 `'local' | 'utc'`（完整 IANA 落点留作后续，标签可经 `formatAxis` 自定义）。**新增 `demo/history/`**（注册进 `vite.demo.config.ts` + 侧栏，演示墙钟轴 / 缩放切时段 / tz 切换 / 详情面板用 `dateOf()`）。
   - 验证：calendarTicks 单测通过（sub-minute 标签、午夜日界 chip、月界日步进、超大 span、UTC 确定性）；浏览器实测：宽视野 30s/HH:mm:ss 刻度、放大 < 阈值切回 `5.00 s`、tz local↔utc 重建正确、刻度粒度随画布宽度自适应；typecheck / build / build:demo 全绿。
   - Phase 3 再给 `demo/history/` 补上「向左拖加载更旧历史」的向后路径。
3. **Phase 3 — 向后加载交互 ✅ 已完成（含对抗审查修复）**：`backfill` 开关（**未放宽 clampView**——`'start'` 检测走 clampView 前的 desiredV0，与 `'end'` 同理，规避了 end-only 用户回归）；镜像左缘子系统（startHint visible/center/hit、drawEdgeHints 左分支 + drawRefreshIcon 镜像、maybeReachEdge 'start' startSpin(edge)、可点击 + 去重 guard）；记 `prevStart` + `pendingPanToStart` 露出；**基于时间的无跳动锚点**（§7.5，硬不变量）；`appendData` 前插自然支持；`setEdgeExhausted(edge)`；demo `demo/history/` 向后路径 + in-flight 守卫。
   - 验证:浏览器实测无跳动锚点 jumpPx=0(两次前插、折叠数据)、真实 `onReachEdge('start')` 加载(17:00→16:45)、空批次到头("已到最早")、到头后拖动全程 no-op、无 console 报错;typecheck/build/build:demo 绿。
   - **对抗审查（2/4 reviewer + 自审）修复的真问题**:① `setEdgeExhausted` 现会停掉该侧在转图标(空批次 host 不 setData→不 clearSpin,否则空转到 12s);② `maybeReachEdge` 对已到头的边不再 fire/spin;③ 安全超时 `stopSpin` 现一并清 `pendingPanTo*`(避免日后无关 setData 意外平移);④ 末端点击补上与起点对称的 `reachedEdge` 连点去重。
   - ~~已知限制~~ **已在 Phase 5 一并处理**:① 小批量前插贴边 → 露出加 `margin = 5% span` 余量,有空间时不贴边(§B1);② 同帧 start+end 并发 → spin 改**逐边**(`spinAt{start,end}` + per-edge 超时 + 共享 rAF),`setData` 按哪端增长**精确停那端**、露出只复位「数据已到」那端的 pending(另一端待露出保留),两侧可各自转各自(§B2)。
4. **Phase 4 — 规模与可读性 ✅ 已完成**
   - Part B（`totalDomain` minimap + 降级链）：新增 `totalDomain?: [number,number] | (()=>...)` 选项;`currentDomain()`（并入 extent,保证已加载数据不落域外）;minimap x 映射改用 domain、未加载两侧画暗色肩部、domain 变化即重建缓存;seekMinimap 也按 domain;**纯显示(方案 A)** —— `clampView`/`maybeReachEdge` 仍读 extent。**保留为可选库能力,但默认不用、demo 也不用**:实测发现按比例预留未加载空间会吞掉缩略图大半面积(只加载 1/4 域时右侧一小条、左侧 3/4 空),得不偿失;缩略图本职是导航已加载数据,「还有更多」由左缘加载图标 + `setEdgeExhausted` 表达即可。不传 `totalDomain` 时 `currentDomain()` 回退 extent → 缩略图铺满已加载数据(原行为)。
   - Part A（`maxNodes` 非对称淘汰）：新增 `maxNodes?: number`;`appendData` 用**并入前**的现有数据判定方向(前插→丢最新端 / 追加→丢最旧端 / 交错→不淘汰),`evictToCap` 以整支顶层 trace 为单位丢到上限,至少留 1 支;淘汰后走同一「基于时间的无跳动锚点」。验证:浏览器实测 deepNodes 见顶于 maxNodes(166→181 不再涨到 332)、topLevel 稳定;**实现期发现并修复一处真 bug** —— 方向判定误用了「并入后」的合并数组(总把方向判成交错而从不淘汰),改用并入前 `this.data` 修正。
   - **设计权衡(非缺陷)**:淘汰丢的是「远离加载方向」的一端;若用户恰好把视口停在被淘汰那侧(如向后加载时却盯着最新端),该侧内容被删 → 视口会跳到最近的存活内容(无法保留已删内容)。正常向后浏览(看历史、拖左缘)时被淘汰的最新端在视野外,无跳动锚点 jumpPx=0 成立。
5. **Phase 5 — 实时/历史可读层 ✅ 已完成**：`live` 态 + `isLive()`/`setLive(on)`/`jumpToNow()` + `onLiveChange(live)` 回调。`jumpToNow()` 跳到最新一端 + 滚到底 + 进入 live;live 下 `setData`(keepView 且末端增长)自动推进视口到 `extent[1]` 跟随;任何手动平移/缩放/纵向滚动经 `exitLive()` 退出(handleWheel 顶 + drag moved≥4)。host 据 `onLiveChange` 渲染 Live/History 徽标。`demo/history/` 加了 Live 徽标 + 「回到当下」+「推送新数据」。验证:浏览器实测状态机(历史→push 不进 live→jumpToNow=Live→push 仍 Live 跟随→手动平移=历史)、live 视口跟随到最新、forward-only(loadmore)与 backward 回归均正常、无 console 报错。纯 opt-in、不与核心耦合。

6. **边缘加载提示重做(交互打磨)✅ 已完成**:原「两端各一个可点刷新圈(空闲也常驻)」读起来像重复装饰、语义(刷新≠加载更多)也不准。改为**无限滚动模型**:
   - **去掉图标的点击触发**(移除 `endHintHit`/`startHintHit` + handleWindowMouseUp 两个点击分支);加载只靠**拖到边缘**(`maybeReachEdge` 手势触发,并在此处置 `pendingPanTo*` 以便异步加载完成后露出新数据)。
   - **空闲态**:不画图标,改画一抹**极淡的边缘渐隐**(`drawEdgeFade`,主题感知白/黑、alpha 0.13→0、宽 40px),暗示「这边还能拖出更多」。
   - **加载态**:该侧才出现 spinner(`drawRefreshIcon`,仅 `isSpinning(edge)` 时)。
   - **左/右/双侧三种情况完全一致**:`drawEdgeHints` 逐边独立、同一套规则(`backfill` 仅是「是否启用向后」的能力门,非交互差异)。
   - 验证:浏览器实测「点边缘不触发(1段→1段)、拖到边缘触发(→2段)」、空闲淡影两端一致可见、loadmore(forward-only)回归正常、无报错。
   - **并发串行化(实测发现的真 bug → 修复)**:两侧都可加载时,快速左右拖会出现「双 spinner」。根因是库在 `startSpin` 后才 `onReachEdge`,而 host 常用单个 in-flight 守卫只挡了请求、挡不住库抢先转的第二个 spinner → 它没有 `setData` 收尾,空转到 12s。**决策:同一时刻只允许一个加载在途**——`maybeReachEdge` 在 fire 前 `if (this.isSpinning()) return`(仍 set reachedEdge 保去抖)。只挡**同时**、不挡**先后**(前一个 `setData` 收尾、reachedEdge 重置后,下一侧照常触发)。这让之前为并发做的 per-edge spin(B2)成为「备而不用」。实测:快速左右拖 → 加载途中只一侧 spinner、收尾后两侧皆停、只一个请求;先后加载(start 完再 end)正常。

## 14. 必修问题清单（对抗审查 → 解法映射）

| 问题 | 解法 | 章节 |
|---|---|---|
| 折叠组 id 不稳定，行 id 锚点失效 | 锚点改为基于时间 offset | §7.5 |
| minimap 纵向随 prepend 重排 | 接受重排（缩略图本应反映新历史） | §8 |
| timeExtent 废掉边缘加载 | backfill 下禁用/调和 timeExtent | §9 |
| clampView 门控误伤 end-only 用户 | 用显式 `backfill` 开关 | §7.1 |
| 跨批折叠接缝不合并 | 不做改变产出的前插优化，文档化按批折叠 | §10 |
| sub-day 刻度 DST 漂移 | sub-day 也用真实 Date 步进 | §5.2 |
| auto 在 offset 0 接缝抖动 | 两个触发都加滞回/死区闩锁 | §4 |
| 深历史 offset 大、抵消重现 | 刻度用索引/Date 步进,不累加 | §3, §5.2 |
| epochOf/dateOf 在无 origin 时 NaN | 契约返回 undefined | §6 |
| Intl 逐 tick 逐帧昂贵 | formatter + 标签缓存 | §5.4 |
| 总域无法提前告知 | 降级链(渐宽 getter / `setEdgeExhausted` 布尔 / 退回 fit-to-extent)；核心不依赖总域 | §8.4 |

## 15. 仍待拍板 / 后续

**Phase 1–5 全部完成。** 剩余均为可选后续:

- `totalDomain` 方案 B(权威可导航域 + `loadRange(t0,t1)` 任意时刻跳转):当前为方案 A 纯显示且默认不用;若需要「点缩略图任意位置直达未加载时刻」再排期。
- 时间锚点的「就近匹配容差」是否要做成 host 可配置(目前固定就近)。
- IANA 完整时区**落点**(目前 local/utc;标签已可经 formatAxis 自定义)。
- 真·同帧 start+end 并发的更细打磨(目前已逐边 spin + 独立露出,不 wedge;极端交错批次的露出取舍可再调)。
