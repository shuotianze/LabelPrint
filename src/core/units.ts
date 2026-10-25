/**
 * 单位换算
 * ------------------------------------------------------------------
 * 打印机内部只有"点(dot)"，界面上一律用毫米(mm)。
 * 换算基准只有一个：dpi。203dpi 时 1mm = 203/25.4 ≈ 7.992 点，
 * 384 点的打印头因此正好是 48mm 宽。
 *
 * 注意：不要拿整数 8 当换算系数，虽然误差只有 0.1%，
 * 但 100mm 长的标签会差掉 1 个点，累积起来条码就扫不出来了。
 */

/** 一寸 = 25.4 毫米，这是国际单位制定义，不是近似值 */
export const MM_PER_INCH = 25.4;

/** 毫米 → 点 */
export function mmToDots(mm: number, dpi: number): number {
  return Math.round((mm * dpi) / MM_PER_INCH);
}

/** 点 → 毫米 */
export function dotsToMm(dots: number, dpi: number): number {
  return (dots * MM_PER_INCH) / dpi;
}

/** 每毫米多少点（渲染时的高频换算，缓存成函数返回值即可） */
export function dotsPerMm(dpi: number): number {
  return dpi / MM_PER_INCH;
}

/** 保留一位小数，避免界面上出现 29.999999 这种数字 */
export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
