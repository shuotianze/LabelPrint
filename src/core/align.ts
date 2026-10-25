/**
 * 以中间点为基准的横向布局
 * ------------------------------------------------------------------
 * 一句话：先定中心，再往左右各摊一半宽度。
 *
 *     中心 X   cx    = left + w / 2
 *     左边界   left  = cx - w / 2
 *     右边界   right = cx + w / 2
 *
 * 宽度从 30 变成 50、中心不动时：
 *   左边往左让 10mm、右边往右让 10mm，两边对称，中心 X 一个点都不动。
 *
 * 为什么单独拎出来一个模块：
 * 编辑器、模板、打印链路都要"居中"，但各自手写 `x = (W - w) / 2` 很容易走样
 * （有的按纸宽算、有的按可打印宽度算；元素比纸还宽时一边溢出去）。
 * 这里只有一份实现，参数、默认值、越界夹紧规则都写死在一处。
 *
 * 坐标全部是毫米、以标签左上角为原点，和文档模型一致。
 */
import type { BaseElement, PaperSetup } from "./label-doc";
import { MM_PER_INCH } from "./units";

/** 容器宽度默认 50mm：B1 实测能打满这个宽度，也是 App 的默认纸宽 */
export const DEFAULT_CONTAINER_MM = 50;

/** 左右留边默认 0：不留边就是"整张纸的中心"，即 50 / 2 = 25mm */
export const DEFAULT_GUTTER_MM = 0;

/** 元素宽度下限。0 或负数没有排版意义，统一收到 1mm */
export const MIN_WIDTH_MM = 1;

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export interface CenterAlignOptions {
  /** 元素宽度(mm)，必填 */
  widthMm: number;
  /** 容器宽度(mm)，默认 50 */
  containerMm?: number;
  /** 想让元素中心落在哪(mm)，默认取容器正中 containerMm / 2 */
  centerMm?: number;
  /** 左右留边(mm)，默认 0；容器太窄时自动收到 containerMm / 2 */
  gutterMm?: number;
  /**
   * 是否夹到容器内，默认 true。
   * 关掉后 left / right 可以落在纸外（用来算"超宽了多少"）。
   */
  clamp?: boolean;
}

export interface CenterAlignResult {
  /** 实际生效的宽度(mm)，已被下限收过 */
  widthMm: number;
  /** 实际使用的容器宽度(mm) */
  containerMm: number;
  /** 实际使用的留边(mm) */
  gutterMm: number;
  /** 调用方要求的中心 X，可能被夹过 */
  requestedCenterX: number;
  /** 实际生效的中心 X —— 落位后从左边反算，保证和 left / right 严格一致 */
  centerX: number;
  /** 左边界(mm) */
  left: number;
  /** 右边界(mm)，= left + widthMm */
  right: number;
  /** 中心是否因为贴边被挪过（调用方可以据此提示用户） */
  shifted: boolean;
  /** 超出可摆放宽度的量(mm)，0 表示放得下 */
  overflowMm: number;
}

/**
 * 计算"以中心为基准"的左右边界。
 * ------------------------------------------------------------------
 * 推导过程：
 *   1. 有中心、有宽度，左右边界就唯一确定了：
 *        left = cx - w / 2
 *        right = left + w = cx + w / 2
 *   2. 夹紧（clamp = true）：元素不能越过留边。
 *        最小中心 = gutter + w / 2
 *        最大中心 = container - gutter - w / 2
 *      cx 落在这个区间外时，整体平移到最近的边界。
 *   3. 元素比容器还宽（w > container - 2 * gutter）：怎么挪都会溢出，
 *      此时让中心停在容器正中，左右溢出量相等——这就是"对称溢出"。
 */
export function centerAlign(opts: CenterAlignOptions): CenterAlignResult {
  const w = Math.max(MIN_WIDTH_MM, Number.isFinite(opts.widthMm) ? opts.widthMm : MIN_WIDTH_MM);

  const containerRaw = opts.containerMm ?? DEFAULT_CONTAINER_MM;
  const container = Math.max(
    MIN_WIDTH_MM,
    Number.isFinite(containerRaw) ? containerRaw : DEFAULT_CONTAINER_MM
  );

  const gutterRaw = opts.gutterMm ?? DEFAULT_GUTTER_MM;
  const gutter = Math.min(container / 2, Math.max(0, Number.isFinite(gutterRaw) ? gutterRaw : 0));

  /** 真正可以摆元素的宽度 */
  const usable = container - gutter * 2;
  const requested = Number.isFinite(opts.centerMm)
    ? (opts.centerMm as number)
    : container / 2;
  const shouldClamp = opts.clamp ?? true;

  let center = requested;
  let shifted = false;

  if (w <= usable + 1e-9) {
    if (shouldClamp) {
      const minCenter = gutter + w / 2;
      const maxCenter = container - gutter - w / 2;
      const next = Math.min(maxCenter, Math.max(minCenter, requested));
      shifted = Math.abs(next - requested) > 1e-9;
      center = next;
    }
  } else if (shouldClamp) {
    // 比容器还宽：左右对称地溢出去，中心留在容器正中
    center = container / 2;
    shifted = Math.abs(requested - center) > 1e-9;
  }

  const left = round2(center - w / 2);
  const right = round2(left + w);

  return {
    widthMm: w,
    containerMm: container,
    gutterMm: gutter,
    requestedCenterX: round2(requested),
    // 用落位后的 left 反算中心，避免 0.1mm 取整后"中心对不上"
    centerX: round2(left + w / 2),
    left,
    right,
    shifted,
    overflowMm: round2(Math.max(0, w - usable)),
  };
}

/** 元素的当前中心 X */
export function centerOf(box: Pick<BaseElement, "x" | "w">): number {
  return round2(box.x + box.w / 2);
}

/** 这一页实际能摆放的宽度：纸宽和打印头宽度取小的那个 */
export function containerOf(paper: PaperSetup): number {
  const headMm = (paper.printheadDots * MM_PER_INCH) / paper.dpi;
  return Math.min(paper.widthMm, headMm);
}

/** 纸的几何中心 X（够不到的地方不算，所以按 containerOf 折半） */
export function paperCenterMm(paper: PaperSetup): number {
  return round2(containerOf(paper) / 2);
}

/**
 * 把元素按中心摆放：只改 x（给了 widthMm 时连 w 一起改），不动 y / h。
 * 返回值里带 left / right / centerX，面板上可以直接显示。
 */
export function placeByCenter<T extends BaseElement>(
  el: T,
  opts: Omit<CenterAlignOptions, "widthMm"> & { widthMm?: number } = {}
): CenterAlignResult {
  const res = centerAlign({ ...opts, widthMm: opts.widthMm ?? el.w });
  el.x = res.left;
  el.w = res.widthMm;
  return res;
}

/**
 * 改宽度但守住中心：宽度向外扩、向内收都以中心为基准。
 * 这是"拖动右下角手柄时左右两边同时动"的底层算法。
 */
export function resizeKeepCenter<T extends BaseElement>(
  el: T,
  widthMm: number,
  opts: Omit<CenterAlignOptions, "widthMm" | "centerMm"> & { centerMm?: number } = {}
): CenterAlignResult {
  return placeByCenter(el, {
    ...opts,
    widthMm,
    centerMm: opts.centerMm ?? centerOf(el),
  });
}

/** 在纸张里水平居中 */
export function centerInContainer<T extends BaseElement>(
  el: T,
  paper: PaperSetup
): CenterAlignResult {
  const container = containerOf(paper);
  return placeByCenter(el, { containerMm: container, centerMm: container / 2 });
}
