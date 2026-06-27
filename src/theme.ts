import type { ThemeInput, TracelaneTheme } from './types';

export const lightTheme: TracelaneTheme = {
  text: '#1f1f1f',
  textSecondary: '#6e6e6e',
  textTertiary: '#9c9c9c',
  grid: 'rgba(0, 0, 0, 0.08)',
  rowHover: 'rgba(0, 0, 0, 0.045)',
  selection: '#1f1f1f',
  tooltipBg: '#ffffff',
  tooltipBorder: 'rgba(0, 0, 0, 0.12)',
  tooltipShadow: '0 4px 16px rgba(0, 0, 0, 0.10)',
  minimapViewportFill: 'rgba(55, 138, 221, 0.14)',
  minimapViewportStroke: '#378ADD',
  scrollbar: 'rgba(0, 0, 0, 0.28)',
  barLabel: '#ffffff',
  statusError: '#E24B4A',
  statusWarn: '#EF9F27',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", sans-serif'
};

export const darkTheme: TracelaneTheme = {
  ...lightTheme,
  text: '#ececec',
  textSecondary: '#a8a8a8',
  textTertiary: '#7c7c7c',
  grid: 'rgba(255, 255, 255, 0.10)',
  rowHover: 'rgba(255, 255, 255, 0.06)',
  selection: '#ececec',
  tooltipBg: '#262626',
  tooltipBorder: 'rgba(255, 255, 255, 0.14)',
  tooltipShadow: '0 4px 16px rgba(0, 0, 0, 0.45)',
  scrollbar: 'rgba(255, 255, 255, 0.3)',
  statusError: '#F0716F',
  statusWarn: '#F4B450'
};

/**
 * 内置类别调色板。category 未在 categories 注册时,paletteColor 按 key 稳定哈希取色,
 * 保证同一类别每次渲染同色(与数据集无关)。
 * 注:autoCategories 走另一种分配——按出现顺序取色以避免图例撞色,故二者选色不必相同。
 */
export const CATEGORY_PALETTE: readonly string[] = [
  '#378ADD', // 蓝
  '#BA7517', // 琥珀
  '#1D9E75', // 青绿
  '#D4537E', // 粉
  '#7F77DD', // 紫
  '#D85A30', // 珊瑚
  '#2AA9B5', // 青
  '#639922' //  绿
];

/** 由类别 key 稳定取调色板色(同 key 恒定,空 key 落第 0 色) */
export function paletteColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0;
  }
  return CATEGORY_PALETTE[h % CATEGORY_PALETTE.length];
}

export function resolveTheme(theme: ThemeInput | undefined): TracelaneTheme {
  if (theme === 'dark') return darkTheme;
  if (theme === 'light' || theme === undefined) return lightTheme;
  // 对象覆盖:默认并到 light;extends:'dark' 时以 dark 为底,修掉「传 Partial 永远是 light 底」
  const { extends: base, ...overrides } = theme;
  return { ...(base === 'dark' ? darkTheme : lightTheme), ...overrides };
}
