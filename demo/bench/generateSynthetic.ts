/**
 * Synthetic trace generator for the Tracelane benchmark harness.
 *
 * Produces a deterministic, realistic CAUSAL TREE of TraceNode that feeds the
 * existing SYNCHRONOUS Tracelane API unchanged: pass the returned array straight
 * into `new Tracelane({ data })` or `tl.setData(...)` — no async, no extra
 * wiring. `createSpan` (from src/data) assigns valid ids via `uid`, so every
 * node is a well-formed SpanNode; `children` express parent -> child causality.
 *
 * A seeded mulberry32 PRNG makes the same `seed` yield the same tree, so perf
 * numbers are repeatable. We deliberately avoid Math.random for that reason.
 */
import type { TraceNode } from '../../src/types';
import { createSpan } from '../../src/data/factory';

export interface SyntheticOptions {
  spanCount: number; // target TOTAL number of span nodes (1e4 .. 2e6)
  maxDepth?: number; // causal tree depth, default 5
  branching?: number; // avg children per non-leaf, default 4
  timeSpanMs?: number; // total timeline width in ms, default 120000
  pointRatio?: number; // fraction of leaf spans that are instant (duration 0 -> point), default 0.05
  categories?: string[]; // category keys to cycle through
  seed?: number; // for reproducible output, default 1
}

/** Seeded PRNG: same seed -> same sequence in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULT_CATEGORIES = ['ios', 'h5', 'gw', 'svc', 'db', 'cache', 'mq', 'rpc'];

const NAME_PREFIX: Record<string, string> = {
  ios: 'tap',
  h5: 'render',
  gw: 'GET /api',
  svc: 'handle',
  db: 'SELECT',
  cache: 'get',
  mq: 'publish',
  rpc: 'call'
};

export function generateSynthetic(opts: SyntheticOptions): TraceNode[] {
  const spanCount = Math.max(1, Math.floor(opts.spanCount));
  const maxDepth = opts.maxDepth ?? 5;
  const branching = opts.branching ?? 4;
  const timeSpanMs = opts.timeSpanMs ?? 120000;
  const pointRatio = opts.pointRatio ?? 0.05;
  const categories =
    opts.categories && opts.categories.length > 0 ? opts.categories : DEFAULT_CATEGORIES;
  const rand = mulberry32(opts.seed ?? 1);

  // A balanced tree of `branching` fan-out and `maxDepth` depth holds
  // ((b^(d+1) - 1) / (b - 1)) nodes per root. Derive root count from that so we
  // land near the target total; the running budget keeps us within ~5%.
  const nodesPerTree =
    branching <= 1
      ? maxDepth + 1
      : (Math.pow(branching, maxDepth + 1) - 1) / (branching - 1);
  const rootCount = Math.max(1, Math.round(spanCount / nodesPerTree));

  let produced = 0;
  const cat = (depth: number): string => categories[depth % categories.length];
  const nameOf = (category: string): string =>
    `${NAME_PREFIX[category] ?? category} ${Math.floor(rand() * 1000)}`;

  /** Recursively build a span occupying [start, start+duration], depth-limited. */
  function build(depth: number, start: number, window: number): TraceNode {
    produced++;
    const category = cat(depth);
    const atLeaf = depth >= maxDepth || produced >= spanCount;

    let children: TraceNode[] | undefined;
    let duration: number;

    if (atLeaf) {
      // Leaves: a slice of pointRatio are instant events (duration 0 -> point).
      duration = rand() < pointRatio ? 0 : Math.max(1, window * (0.2 + rand() * 0.6));
    } else {
      // Non-leaf occupies most of its window; children nest inside it.
      duration = Math.max(1, window * (0.6 + rand() * 0.35));
      // Vary fan-out around `branching` (1 .. 2*branching-1) for realism.
      const fanout = Math.max(1, Math.round(branching * (0.5 + rand())));
      const kids: TraceNode[] = [];
      const slot = duration / fanout; // sequential lanes within the parent window
      for (let i = 0; i < fanout && produced < spanCount; i++) {
        // Child starts after parent.start, jittered within its lane, and stays
        // inside the parent window so the waterfall reads as real causality.
        const laneStart = start + i * slot + rand() * slot * 0.4;
        const laneWindow = Math.max(1, slot * (0.5 + rand() * 0.4));
        kids.push(build(depth + 1, laneStart, laneWindow));
      }
      // Every level sorted by start ascending (Tracelane renders array order).
      kids.sort((a, b) => a.start - b.start);
      children = kids.length > 0 ? kids : undefined;
    }

    const meta = { depth, traceId: `t${produced}` };
    return createSpan(nameOf(category), category, start, duration, children, meta);
  }

  const roots: TraceNode[] = [];
  const rootWindow = timeSpanMs / rootCount;
  for (let i = 0; i < rootCount && produced < spanCount; i++) {
    // Spread roots across [0, timeSpanMs], one per lane with mild jitter.
    const start = i * rootWindow + rand() * rootWindow * 0.3;
    const window = rootWindow * (0.5 + rand() * 0.4);
    roots.push(build(0, start, window));
  }

  // Top level sorted by start ascending too.
  roots.sort((a, b) => a.start - b.start);
  return roots;
}
