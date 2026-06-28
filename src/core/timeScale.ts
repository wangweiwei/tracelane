/**
 * 绝对（墙钟）时间轴的刻度生成 —— 纯函数，零依赖，仅在 axis 解析为绝对时显示时调用。
 *
 * 设计要点（详见 docs/design/bidirectional-time-axis.md §5）：
 * - 刻度落点用「真实 Date 步进」而非 `t += stepMs` 累加：sub-day 也按 Date 加（在所选
 *   时区下 setHours/setMinutes 等是 DST 感知的），day/month/year 按 setDate/setMonth/
 *   setFullYear，从而 DST 切换、月长差异、闰年都天然正确，且避免浮点累加漂移。
 * - 时区：'local'（浏览器本地，DST 感知）或 'utc'。完整 IANA 落点留作后续；需要其它时区
 *   的标签可经 formatAxis 自定义（落点仍按 local/utc）。
 * - niceStep（src/utils.ts）保持不动，继续服务 elapsed 模式。
 */

export type TimeUnit = 'ms' | 's' | 'min' | 'hour' | 'day' | 'month' | 'year';
export type TimeZoneMode = 'local' | 'utc';

export interface CalendarStep {
  unit: TimeUnit;
  /** 该单位下每隔几格（如 every=15 的 'min' = 每 15 分钟） */
  every: number;
  /** 近似毫秒跨度，仅用于按像素间距选档；落点不依赖它 */
  approxMs: number;
}

export interface CalendarTick {
  /** 绝对时钟 epoch ms */
  abs: number;
  /** 相对 origin 的内部 offset（abs - originEpoch），喂给 xOf */
  offset: number;
  unit: TimeUnit;
  /** 是否本地日界（时:分:秒:毫秒均为 0）→ 渲染时给日期 chip */
  isDayBoundary: boolean;
}

const S = 1000;
const MIN = 60 * S;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 有序刻度阶梯：每档的 every 都能整除其上一单位（保证 floor-to-multiple well-defined） */
const LADDER: CalendarStep[] = [
  { unit: 'ms', every: 1, approxMs: 1 },
  { unit: 'ms', every: 2, approxMs: 2 },
  { unit: 'ms', every: 5, approxMs: 5 },
  { unit: 'ms', every: 10, approxMs: 10 },
  { unit: 'ms', every: 20, approxMs: 20 },
  { unit: 'ms', every: 50, approxMs: 50 },
  { unit: 'ms', every: 100, approxMs: 100 },
  { unit: 'ms', every: 200, approxMs: 200 },
  { unit: 'ms', every: 500, approxMs: 500 },
  { unit: 's', every: 1, approxMs: S },
  { unit: 's', every: 2, approxMs: 2 * S },
  { unit: 's', every: 5, approxMs: 5 * S },
  { unit: 's', every: 10, approxMs: 10 * S },
  { unit: 's', every: 15, approxMs: 15 * S },
  { unit: 's', every: 30, approxMs: 30 * S },
  { unit: 'min', every: 1, approxMs: MIN },
  { unit: 'min', every: 2, approxMs: 2 * MIN },
  { unit: 'min', every: 5, approxMs: 5 * MIN },
  { unit: 'min', every: 10, approxMs: 10 * MIN },
  { unit: 'min', every: 15, approxMs: 15 * MIN },
  { unit: 'min', every: 30, approxMs: 30 * MIN },
  { unit: 'hour', every: 1, approxMs: HOUR },
  { unit: 'hour', every: 2, approxMs: 2 * HOUR },
  { unit: 'hour', every: 3, approxMs: 3 * HOUR },
  { unit: 'hour', every: 6, approxMs: 6 * HOUR },
  { unit: 'hour', every: 12, approxMs: 12 * HOUR },
  { unit: 'day', every: 1, approxMs: DAY },
  { unit: 'day', every: 2, approxMs: 2 * DAY },
  { unit: 'day', every: 7, approxMs: 7 * DAY },
  { unit: 'day', every: 14, approxMs: 14 * DAY },
  { unit: 'month', every: 1, approxMs: 30 * DAY },
  { unit: 'month', every: 3, approxMs: 91 * DAY },
  { unit: 'month', every: 6, approxMs: 182 * DAY },
  { unit: 'year', every: 1, approxMs: 365 * DAY }
];

/** 选「像素间距 ≥ 目标」的最小一档：target = spanMs / 目标刻度数 */
export function pickCalendarStep(spanMs: number, targetTickCount: number): CalendarStep {
  const target = spanMs / Math.max(targetTickCount, 1);
  for (const rung of LADDER) {
    if (rung.approxMs >= target) return rung;
  }
  return LADDER[LADDER.length - 1];
}

/** 时区感知的字段读写：local 用本地 getter/setter，utc 用 UTC 版（无 DST） */
interface DateOps {
  year(d: Date): number;
  month(d: Date): number;
  date(d: Date): number;
  hours(d: Date): number;
  minutes(d: Date): number;
  seconds(d: Date): number;
  ms(d: Date): number;
  set(d: Date, p: { Y?: number; Mo?: number; D?: number; h?: number; m?: number; s?: number; ms?: number }): void;
}

function ops(tz: TimeZoneMode): DateOps {
  const utc = tz === 'utc';
  return {
    year: (d) => (utc ? d.getUTCFullYear() : d.getFullYear()),
    month: (d) => (utc ? d.getUTCMonth() : d.getMonth()),
    date: (d) => (utc ? d.getUTCDate() : d.getDate()),
    hours: (d) => (utc ? d.getUTCHours() : d.getHours()),
    minutes: (d) => (utc ? d.getUTCMinutes() : d.getMinutes()),
    seconds: (d) => (utc ? d.getUTCSeconds() : d.getSeconds()),
    ms: (d) => (utc ? d.getUTCMilliseconds() : d.getMilliseconds()),
    set: (d, p) => {
      if (utc) {
        if (p.Y !== undefined) d.setUTCFullYear(p.Y);
        if (p.Mo !== undefined) d.setUTCMonth(p.Mo);
        if (p.D !== undefined) d.setUTCDate(p.D);
        if (p.h !== undefined) d.setUTCHours(p.h);
        if (p.m !== undefined) d.setUTCMinutes(p.m);
        if (p.s !== undefined) d.setUTCSeconds(p.s);
        if (p.ms !== undefined) d.setUTCMilliseconds(p.ms);
      } else {
        if (p.Y !== undefined) d.setFullYear(p.Y);
        if (p.Mo !== undefined) d.setMonth(p.Mo);
        if (p.D !== undefined) d.setDate(p.D);
        if (p.h !== undefined) d.setHours(p.h);
        if (p.m !== undefined) d.setMinutes(p.m);
        if (p.s !== undefined) d.setSeconds(p.s);
        if (p.ms !== undefined) d.setMilliseconds(p.ms);
      }
    }
  };
}

/** 两个时区的 DateOps 单例:模块加载时各建一次,避免每次 calendarTicks/formatAxis 调用都重建 8 个闭包 */
const OPS: Record<TimeZoneMode, DateOps> = { local: ops('local'), utc: ops('utc') };

/** 把 d 向下取整到 step 的边界（在所选时区下），返回新 Date */
function floorTo(d: Date, step: CalendarStep, o: DateOps): Date {
  const r = new Date(d.getTime());
  const { unit, every } = step;
  // 先清零比当前单位更小的字段，再把当前单位 floor 到 every 的倍数
  switch (unit) {
    case 'ms':
      o.set(r, { ms: Math.floor(o.ms(r) / every) * every });
      break;
    case 's':
      o.set(r, { ms: 0, s: Math.floor(o.seconds(r) / every) * every });
      break;
    case 'min':
      o.set(r, { ms: 0, s: 0, m: Math.floor(o.minutes(r) / every) * every });
      break;
    case 'hour':
      o.set(r, { ms: 0, s: 0, m: 0, h: Math.floor(o.hours(r) / every) * every });
      break;
    case 'day':
      // 对齐到本地午夜；2/7/14 天的相位以该日为准（足够稳定，平移不漂）
      o.set(r, { ms: 0, s: 0, m: 0, h: 0 });
      break;
    case 'month':
      o.set(r, { ms: 0, s: 0, m: 0, h: 0, D: 1, Mo: Math.floor(o.month(r) / every) * every });
      break;
    case 'year':
      o.set(r, { ms: 0, s: 0, m: 0, h: 0, D: 1, Mo: 0, Y: Math.floor(o.year(r) / every) * every });
      break;
  }
  return r;
}

/** 在 d 上前进一格（真实 Date 运算，DST/月长/闰年安全），返回新 Date */
function advance(d: Date, step: CalendarStep, o: DateOps): Date {
  const r = new Date(d.getTime());
  const { unit, every } = step;
  switch (unit) {
    case 'ms':
      o.set(r, { ms: o.ms(r) + every });
      break;
    case 's':
      o.set(r, { s: o.seconds(r) + every });
      break;
    case 'min':
      o.set(r, { m: o.minutes(r) + every });
      break;
    case 'hour':
      o.set(r, { h: o.hours(r) + every });
      break;
    case 'day':
      o.set(r, { D: o.date(r) + every });
      break;
    case 'month':
      o.set(r, { Mo: o.month(r) + every });
      break;
    case 'year':
      o.set(r, { Y: o.year(r) + every });
      break;
  }
  return r;
}

/**
 * 生成 [absStart, absEnd] 区间内的日历刻度（含起点前一格 floor，避免左缘漏画）。
 * originEpoch 用于把 abs 换算成内部 offset。tz 决定落点与日界判定的时区。
 * 上限 maxTicks 防御异常输入（如 span 巨大但选到极小档）导致死循环。
 */
export function calendarTicks(
  absStart: number,
  absEnd: number,
  step: CalendarStep,
  originEpoch: number,
  tz: TimeZoneMode,
  maxTicks = 4096
): CalendarTick[] {
  const o = OPS[tz];
  const out: CalendarTick[] = [];
  let cur = floorTo(new Date(absStart), step, o);
  let guard = 0;
  while (cur.getTime() <= absEnd && guard < maxTicks) {
    const abs = cur.getTime();
    if (abs >= absStart) {
      out.push({
        abs,
        offset: abs - originEpoch,
        unit: step.unit,
        isDayBoundary:
          o.hours(cur) === 0 && o.minutes(cur) === 0 && o.seconds(cur) === 0 && o.ms(cur) === 0
      });
    }
    const next = advance(cur, step, o);
    if (next.getTime() <= abs) break; // 不前进则止（防御）
    cur = next;
    guard += 1;
  }
  return out;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/**
 * 默认绝对刻度标签（按粒度分级；日界用日期）。需要其它时区或样式经 formatAxis 覆盖。
 * - ms: HH:mm:ss.SSS ；s: HH:mm:ss ；min/hour: HH:mm
 * - 日界(isDayBoundary)的 sub-day 刻度：显示日期（MM-DD），渲染层据此画 chip
 * - day: MM-DD ；month: YYYY-MM ；year: YYYY
 */
export function formatAxisDefault(
  epochMs: number,
  ctx: { unit: TimeUnit; stepMs: number; isDayBoundary: boolean; tz?: TimeZoneMode }
): string {
  const o = OPS[ctx.tz ?? 'local'];
  const d = new Date(epochMs);
  const date = `${pad(o.month(d) + 1)}-${pad(o.date(d))}`;
  const ymd = `${o.year(d)}-${date}`;
  switch (ctx.unit) {
    case 'ms':
      return ctx.isDayBoundary ? date : `${pad(o.hours(d))}:${pad(o.minutes(d))}:${pad(o.seconds(d))}.${pad(o.ms(d), 3)}`;
    case 's':
      return ctx.isDayBoundary ? date : `${pad(o.hours(d))}:${pad(o.minutes(d))}:${pad(o.seconds(d))}`;
    case 'min':
    case 'hour':
      return ctx.isDayBoundary ? date : `${pad(o.hours(d))}:${pad(o.minutes(d))}`;
    case 'day':
      return date;
    case 'month':
      return ymd.slice(0, 7);
    case 'year':
      return String(o.year(d));
  }
}
