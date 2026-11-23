/**
 * 与 Web 端同一套 token（docs/04-UI设计规范.md）。
 *
 * 移动端没法用 CSS 变量，所以这里是唯一的颜色来源 —— 组件里不许出现裸 hex，
 * 否则 Web 改一个色值，两端就悄悄分叉了。
 */
export const C = {
  n0: '#ffffff',
  n50: '#fafafa',
  n100: '#f4f4f5',
  n200: '#e4e4e7',
  n300: '#d4d4d8',
  n400: '#a1a1aa',
  n500: '#71717a',
  n600: '#52525b',
  n700: '#3f3f46',
  n900: '#18181b',
  a100: '#edf1fa',
  a200: '#c8d3ee',
  a500: '#002fa7',
  a600: '#00227a',
  a700: '#001a5c',
  danger: '#c0311e',
  warn: '#a16207',
} as const;

/** 间距只有这 8 个值（与 Web 相同） */
export const SP = { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32, 12: 48, 16: 64 } as const;

export const FONT = {
  xs: 11,
  sm: 12,
  base: 13,
  body: 15,
  md: 17,
  lg: 21,
  xl: 28,
} as const;

/** 可点区域下限：低于这个值手指点不准（docs/06 K9） */
export const HIT = 44;
