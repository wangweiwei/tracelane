<p align="center">English | <a href="./README.zh-CN.md">简体中文</a></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/wangweiwei/tracelane/main/assets/logo.svg" alt="Tracelane logo — a zero-dependency TypeScript Canvas library that renders full-link traces as a zoomable causal-tree waterfall" width="320" />
</p>

<p align="center">
  Time as the warp, behavior as the weft — a full-link behavior timeline.
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
  <a href="https://wangweiwei.github.io/tracelane/"><img src="https://img.shields.io/badge/Live_Demo-378ADD?style=flat-square&logo=github&logoColor=white" alt="Live Demo" /></a>
  <a href="https://stackblitz.com/github/wangweiwei/tracelane"><img src="https://img.shields.io/badge/Open_in_StackBlitz-1389FD?style=flat-square&logo=stackblitz&logoColor=white" alt="Open in StackBlitz" /></a>
</p>

## What is Tracelane?

**Tracelane is a zero-dependency, framework-agnostic TypeScript library that renders full-link user-behavior traces as a zoomable, collapsible causal-tree waterfall on an HTML Canvas, where each span is one row and indentation expresses parent-to-child causality.** It turns "what the user did, on which client, at what time — and which downstream gateway, service, and store calls it triggered, each for how long" into one interactive waterfall.

Built on native Canvas 2D with zero runtime dependencies and bundled TypeScript declarations, Tracelane works identically in React, Vue, Svelte, or vanilla HTML — you mount the `Tracelane` class on a plain DOM element. It is designed for full-link traces, distributed tracing, user-behavior chains, span waterfalls, and observability/APM timeline views, and is MIT-licensed.

## Features

- **Infinite zoomable time axis** — `Ctrl`/`⌘` + wheel (or trackpad pinch) zooms the time axis centered on the cursor; drag to pan; a bottom minimap always shows the whole picture and supports drag-to-seek.
- **Causal-tree waterfall** — each behavior/span occupies one row, and indentation expresses parent-to-child causality (client → gateway → service → store); click a row to expand or collapse.
- **Sibling folding** — `foldSiblings` collapses "same-category, consecutive, count-threshold" repeated behaviors (heartbeats, pagination, batched SQL) into a `×N` aggregate bar, showing member tick marks plus cumulative and mean stats.
- **Virtualized row rendering** — only the rows inside the visible viewport are drawn, so growing the row count does not increase per-frame rendering cost.
- **Free data customization** — two orthogonal seams: structurally, `fromFlatSpans` / `fromTree` normalize any source (via field mapping) into the canonical model; presentationally, `colorOf` / `labelOf` / `shapeOf` / `statusOf` re-color, re-label, draw instantaneous-event diamonds, and mark error status — all without mutating the data.
- **Light / dark themes and more** — category colors and labels are optional (unregistered categories auto-pick from a built-in 8-color palette); light/dark themes (`theme: 'dark'` or `{ extends: 'dark', ...overrides }` to tweak a preset); time formatter and tooltip renderer are injectable; selection, expansion, and viewport changes all fire callbacks.

## Installation

```bash
npm install tracelane
# or
pnpm add tracelane
# or
yarn add tracelane
```

## Quick Start (ESM)

```ts
import { Tracelane, createSpan, foldSiblings } from 'tracelane';

const data = foldSiblings([
  createSpan('Tap "Submit order"', 'ios', 0, 420, [
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
    ios: { label: 'iOS client', color: '#378ADD' },
    gw: { label: 'Gateway', color: '#D4537E' },
    svc: { label: 'Service', color: '#1D9E75' },
    db: { label: 'Store', color: '#BA7517' }
  },
  onSelect(node) {
    console.log('selected', node);
  }
});
```

## Use via CDN (no build step)

```html
<div id="timeline"></div>
<script src="https://unpkg.com/tracelane/dist/tracelane.umd.cjs"></script>
<script>
  const { Tracelane, createSpan, foldSiblings } = Tracelane;
  const data = foldSiblings([
    createSpan('Tap "Submit order"', 'ios', 0, 420)
  ]);
  new Tracelane(document.getElementById('timeline'), { data });
</script>
```

The UMD global `Tracelane` is a namespace object that carries every named export (the class `Tracelane`, plus `createSpan`, `foldSiblings`, etc., are all destructured from it). jsDelivr works too: `https://cdn.jsdelivr.net/npm/tracelane/dist/tracelane.umd.cjs`.

## Data Model

Time is always measured in milliseconds, and `start` is the offset relative to the timeline origin (T+0). When ingesting real data, anchor to a server-side clock to avoid client-vs-cloud clock skew that would otherwise make a "response appear earlier than its request".

```ts
interface SpanNode {
  kind: 'span';
  id: string;             // corresponds to spanId
  name: string;           // display name
  category: string;       // category key; register it in `categories`
  start: number;          // start (ms), relative to T+0
  duration: number;       // duration (ms)
  children?: TraceNode[]; // causal child nodes
  hasChildren?: boolean;  // "logically has children": draws the expand arrow even
                          // when children aren't loaded yet (lazy loading);
                          // defaults to being derived from `children`
  meta?: Record<string, unknown>; // traceId / user / device, etc.; returned as-is in callbacks
}

// GroupNode reuses all of SpanNode's common fields
// (id / name / category / start / duration / children / meta),
// adding `count` and `total`.
interface GroupNode {
  kind: 'group';
  count: number; // number of members
  total: number; // sum of member durations (note: `duration` is the head-to-tail
                 // span, not the sum of members)
  // ...plus id / name / category / start / duration / children / meta
}
```

### Folding utilities

```ts
foldSiblings(children, {
  gap: 12000,   // max idle gap between adjacent repeats; beyond it, split into two groups (default 12000)
  minCount: 3,  // fold only when consecutive repeats reach this count (default 3)
  keyOf: (n) => `${n.category}|${n.name.replace(/\d+/g, '{n}')}` // fold key
});
foldTree(nodes, options); // fold an entire tree, level by level
```

Normalizing the fold key (e.g. stripping URL/SQL parameters) is best precomputed during instrumentation or on the server and injected via `keyOf`; the default client-side implementation only normalizes digits.

## Data Ingestion / Adapters

Data customization splits into two orthogonal seams that can be used independently.

### Seam 1 — Structural mapping: any source → canonical tree

Backend traces are usually a **flat span list** (each row carries a `parentId`, and `start` is an absolute clock). `fromFlatSpans` builds the causal tree from this and anchors the time axis. Each field accepts **either a field name or a function**:

```ts
import { fromFlatSpans, foldTree } from 'tracelane';

const data = foldTree(
  fromFlatSpans(rawSpans, {
    id: 'spanId',
    parentId: 'parentSpanId',           // null / missing parent => root
    name: (r) => `${r.method} ${r.route}`,
    category: (r) => r.service,         // open string; unregistered categories auto-pick a color
    start: 'startUnixMs',               // absolute clock (epoch ms)
    duration: 'durationMs',
    origin: 'auto',                     // T+0 anchor: 'auto' = min(start) | number | (rows) => number
    meta: (r) => r                      // raw row returned as-is; default is r => r
  })
);
```

The boundary cases are all defined: **orphans** (parent not found) are promoted to roots, **parent–child cycles** are broken and demoted to roots, and **duplicate ids** are overwritten by the later occurrence — all summarized in a single `console.warn`. Each level is sorted ascending by `start`. Folding is orthogonal: wrap the result in `foldTree` when you want it.

For data that is already nested, use `fromTree(roots, { children, ...same fields })`. For a stable legend, `autoCategories(data)` pre-generates `categories`.

Time anchoring belongs solely to the adapter: `origin: 'auto'` yields a relative view; for wall-clock axis labels, pass an **explicit server-side anchor**, then restore it with `formatTime(t + origin)` to avoid client-vs-cloud skew producing a "response earlier than its request".

### Seam 2 — Presentational encoding: same data, different rendering

The hooks below live on `TracelaneOptions`. They are all optional, fall back to current behavior when omitted, and are non-breaking. Each receives a canonical node, and `meta` holds your original row:

| Hook | Purpose | Default |
| --- | --- | --- |
| `colorOf(node)` | Override the category color (label / bar / minimap stay in sync) | Returns `undefined` → use the category color |
| `labelOf(node)` | The full left-column row text | Group nodes get `×N`, otherwise `name` |
| `shapeOf(node)` | `'bar'` duration bar / `'point'` instantaneous-event diamond | `duration <= 0` is treated as `point` |
| `statusOf(node)` | `'error'` / `'warn'` accent on the row's left edge | Returns `undefined` → no accent |

```ts
new Tracelane(el, {
  data,                                              // categories optional; colors auto-assigned
  colorOf: (n) => (n.meta?.error ? '#E24B4A' : undefined),
  statusOf: (n) => (Number(n.meta?.httpStatus) >= 500 ? 'error' : undefined)
});
```

## API

| Method | Description |
| --- | --- |
| `new Tracelane(container, options)` | Mount the component; see the `TracelaneOptions` type for all options |
| `setData(data, { keepView })` | Replace the data; when `keepView` is true, the current time viewport and scroll position are preserved |
| `appendData(nodes)` | Incrementally append top-level nodes while preserving the current viewport (pairs with `onReachEdge` for infinite scroll); appended nodes' `start` must share the same time origin as the existing data |
| `setTheme(theme)` | Switch theme at runtime (`'light'` / `'dark'` / override object); data, viewport, expansion, and selection state are all preserved |
| `setHiddenCategories(keys)` / `getHiddenCategories()` | Category filter — hide the given categories' spans and their causal subtrees (empty = show all); the minimap filters too |
| `zoomIn()` / `zoomOut()` / `zoomTo(t0, t1)` / `resetView()` / `getView()` | Time viewport control |
| `expand(id)` / `collapse(id)` / `expandAll()` / `collapseAll()` / `setExpanded(ids)` / `getExpanded()` | Expansion-state control |
| `select(id \| null)` | Select a node and fire `onSelect` |
| `reveal(id)` | Expand ancestors, scroll to the row, pan the time viewport if needed, and select — for search-to-locate |
| `destroy()` | Unmount and remove all listeners |

Callbacks: `onSelect(node)`, `onExpandChange(ids)`, `onViewChange([v0, v1])`, and `onReachEdge(edge, [v0, v1])` — where `edge` is `'start'` / `'end'`. Passing `onReachEdge` enables "load more on scroll": it pairs with `appendData` for infinite scroll.

## Other Exports

Beyond the API above, the package also exports:

- `createSpan` / `createGroup` — build nodes by hand. `createGroup(name, category, members, meta?)` computes `start` / `duration` / `count` / `total` automatically.
- `fromFlatSpans` / `fromTree` / `autoCategories` — structural-mapping adapters (see [Data Ingestion / Adapters](#data-ingestion--adapters)).
- `paletteColor(key)` and `CATEGORY_PALETTE` — key-stable colors from the built-in 8-color palette.
- `lightTheme` / `darkTheme` / `resolveTheme(input)` — construct a complete `TracelaneTheme`.
- `formatTimeDefault(ms)` — the default time formatter.
- All TypeScript types: `TraceNode` / `SpanNode` / `GroupNode` / `TraceNodeBase` / `CategoryStyle` / `TracelaneOptions` / `TracelaneTheme` / `ThemeOverride` / `ThemeInput` / `FoldOptions` / `NodeStatus` / `BarShape`, plus the adapter types `Get` / `Origin` / `FlatMapping` / `TreeMapping`.

## Interaction Cheatsheet

| Operation | Behavior |
| --- | --- |
| Wheel | Scroll rows vertically |
| `Ctrl`/`⌘` + wheel (trackpad pinch) | Zoom time, centered on the cursor |
| `Shift` + wheel | Pan the time axis horizontally |
| Drag | Pan time horizontally + scroll vertically |
| Click a row with children | Expand / collapse |
| Click a leaf row | Select, firing `onSelect` |
| Press / drag the minimap | Seek the viewport |

## FAQ

### What is Tracelane?

Tracelane is a zero-dependency TypeScript library that visualizes full-link traces and user-behavior chains as a zoomable, collapsible waterfall on an HTML Canvas. Each span/behavior is one row, and indentation expresses parent-to-child causality (e.g. client to gateway to service to store). It renders via Canvas 2D, ships TypeScript types, and is MIT-licensed.

### How is it different from a flamegraph or a Gantt chart?

Like a flamegraph or trace Gantt chart, Tracelane maps duration to bar width on a shared time axis. The difference is layout and interaction: it uses a one-row-per-span causal tree where indentation encodes parent-to-child causality and rows expand/collapse on click, plus it adds an infinite cursor-centered zoomable time axis, a bottom minimap, sibling folding (repeated spans collapse into ×N aggregate bars), and virtualized rendering so only visible rows are drawn.

### Does Tracelane depend on a framework like React or Vue?

No. It is framework-agnostic with zero runtime dependencies. You instantiate the `Tracelane` class against a plain DOM element (`new Tracelane(container, options)`), so it works identically in React, Vue, Svelte, or vanilla HTML. There is also a UMD build for use directly from a CDN with no build step.

### How large a dataset can it handle?

Rendering uses virtualized rows — only spans within the visible viewport are drawn — so vertical row count does not increase per-frame cost. Truncated labels and minimap geometry are cached, and the time axis is independent of dataset depth. For very long histories it also supports load-more-on-scroll: an `onReachEdge` callback fires at the data edge and you append new spans incrementally with `appendData`.

### Does it work with OpenTelemetry, Jaeger, or Zipkin data?

It works with any flat span list or nested tree via generic structural adapters. `fromFlatSpans` takes rows with a `parentId` and absolute-clock timestamps and builds the causal tree (handling orphans, cycles, and duplicate ids), and `fromTree` takes already-nested data. You map your fields (by name or accessor function) to id/parentId/name/category/start/duration. Dedicated `fromOtel`/`fromJaeger`/`fromZipkin` presets are on the roadmap but not yet shipped — today you map those formats through `fromFlatSpans`.

### How do I customize colors, labels, shapes, and status?

Through two orthogonal seams. Structural adapters (`fromFlatSpans` / `fromTree` / `autoCategories`) normalize any source into the canonical tree. Presentational hooks on `TracelaneOptions` re-encode the same data without mutating it: `colorOf(node)` overrides the category color, `labelOf(node)` sets the row text, `shapeOf(node)` chooses a duration bar or an instantaneous-event diamond, and `statusOf(node)` draws an error/warn accent on the row's left edge. Categories can also be registered with explicit label and color, or auto-assigned from a built-in 8-color palette.

### Can I switch between light and dark themes at runtime?

Yes. Pass `theme: 'light' | 'dark'` or an override object (`{ extends: 'dark', ...tokenOverrides }`) at construction, and call `setTheme(theme)` at runtime to switch — data, viewport, expansion, and selection state are all preserved across the change.

### What are the core interactions and the public API?

`Ctrl`/`⌘` + wheel (or trackpad pinch) zooms the time axis centered on the cursor, `Shift` + wheel pans time, drag pans and scrolls, and the bottom minimap seeks the viewport. The public API includes `setData`/`appendData`, `setTheme`, `zoomIn`/`zoomOut`/`zoomTo`/`resetView`/`getView`, `expand`/`collapse`/`expandAll`/`collapseAll`/`setExpanded`/`getExpanded`, `select(id)`, `reveal(id)` for search-to-locate, and `destroy()`, plus `onSelect`/`onExpandChange`/`onViewChange`/`onReachEdge` callbacks.

### Is Tracelane free and open source?

Yes. It is MIT-licensed and free for commercial use, published on npm as `tracelane` with zero runtime dependencies and bundled TypeScript declarations.

## Use Cases / When to Use

- Visualizing a full-link user-behavior trace — what the user did, on which client, and which downstream gateway/service/store calls it triggered and how long each took — as one causal waterfall.
- Inspecting distributed traces (flat spans with `parentId`, or nested trees) as an interactive, zoomable timeline instead of a static image.
- Collapsing high-frequency repeated spans (heartbeats, pagination, batched SQL) into ×N aggregate bars with member tick marks and cumulative/mean stats to keep dense traces readable.
- Embedding an observability/APM timeline view inside a React, Vue, or vanilla web app without pulling in a charting framework or runtime dependencies.
- Browsing very long behavior histories with load-more-on-scroll, appending new spans at the data edge via `onReachEdge` + `appendData`.
- Search-to-locate workflows where `reveal(id)` expands ancestors, scrolls to the row, pans the time viewport, and selects the matching span.

## Why Tracelane

- **Zero runtime dependencies and framework-agnostic** — a single class mounted on a DOM element, usable in React, Vue, or vanilla, with a UMD/CDN build that needs no bundler.
- **Causal-tree waterfall layout** — one row per span with indentation encoding parent-to-child causality and click-to-expand/collapse, rather than a flat or stacked timeline.
- **Two orthogonal customization seams** — structural adapters (`fromFlatSpans` / `fromTree` / `autoCategories`) to ingest any source, and presentational hooks (`colorOf` / `labelOf` / `shapeOf` / `statusOf`) to re-style without mutating data.
- **Sibling folding** — `foldSiblings` / `foldTree` collapse repeated same-category spans into ×N aggregate bars, a built-in answer to noisy high-frequency events.
- **Native Canvas 2D foundation** — virtualized row rendering, cursor-centered infinite zoom, a bottom minimap, runtime light/dark theming, and bundled TypeScript types.

## Local Development

```bash
pnpm install
pnpm dev        # open the demo (in demo/)
pnpm typecheck  # type-check
pnpm build      # produce dist/ (ESM + UMD + d.ts)
```

## Roadmap

Data ingestion is the core of what makes this library usable, so the adapter layer comes first:

- [x] `fromFlatSpans(rawSpans, mapping)` — generic flat-to-tree adapter (field-mapping functions normalize any source into the internal model); `fromTree` ingests already-nested data
- [ ] `fromOtel` / `fromJaeger` / `fromZipkin` — preset adapters (one-line ingestion of standard formats)
- [ ] Expand-to-load: `childrenResolver` for async on-demand drill-down, paired with the `hasChildren` flag
- [ ] LOD pixel-level aggregation: render a density bar when spans are under 1px wide
- [ ] Swimlane (entity) view as a secondary mode, one-click switchable with the waterfall view
- [ ] Search / sort by duration
- [ ] Touch gestures (pinch zoom, two-finger pan)

## License

[MIT](./LICENSE)
