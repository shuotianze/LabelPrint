/**
 * 属性面板的字段描述
 * ------------------------------------------------------------------
 * 面板不做手写死每个元素类型的控件，而是用这张表描述"有哪些字段、
 * 什么控件、范围多少"，再由 editor 的 fieldRow 统一渲染。
 * 加字段＝在这里加一行，不用改渲染代码。
 */

export interface FieldDef {
  key: string;
  label: string;
  kind: "num" | "text" | "area" | "select" | "check" | "range";
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  unit?: string;
}

/** 所有元素都有的字段 */
export const COMMON: FieldDef[] = [
  { key: "x", label: "左", kind: "num", step: 0.1, unit: "mm" },
  { key: "y", label: "上", kind: "num", step: 0.1, unit: "mm" },
  { key: "w", label: "宽", kind: "num", step: 0.1, unit: "mm" },
  /* 中心 X 是"以中间点为基准"的直接入口：
   * 改宽守住它，改它则带着宽度一起平移（x = 中心 - 宽/2）。 */
  { key: "cx", label: "中心 X", kind: "num", step: 0.1, unit: "mm" },
  { key: "h", label: "高", kind: "num", step: 0.1, unit: "mm" },
  {
    key: "rotate",
    label: "旋转",
    kind: "select",
    options: [
      { value: "0", label: "0°" },
      { value: "90", label: "90°" },
      { value: "180", label: "180°" },
      { value: "270", label: "270°" },
    ],
  },
  { key: "visible", label: "参与打印", kind: "check" },
];

/** 各类型元素自己的字段 */
export const FIELDS: Record<string, FieldDef[]> = {
  text: [
    { key: "text", label: "内容", kind: "area" },
    { key: "fontSizeMm", label: "字高", kind: "num", min: 1.2, max: 20, step: 0.1, unit: "mm" },
    { key: "bold", label: "加粗", kind: "check" },
    {
      key: "align",
      label: "水平对齐",
      kind: "select",
      options: [
        { value: "left", label: "左" },
        { value: "center", label: "中" },
        { value: "right", label: "右" },
      ],
    },
    {
      key: "valign",
      label: "垂直对齐",
      kind: "select",
      options: [
        { value: "top", label: "上" },
        { value: "middle", label: "中" },
        { value: "bottom", label: "下" },
      ],
    },
    { key: "lineHeight", label: "行距", kind: "num", min: 1, max: 3, step: 0.05 },
    { key: "wrap", label: "按宽度折行", kind: "check" },
  ],
  barcode: [
    {
      key: "format",
      label: "码制",
      kind: "select",
      options: [
        { value: "CODE128", label: "Code 128" },
        { value: "CODE39", label: "Code 39" },
        { value: "EAN13", label: "EAN-13（13 位数字）" },
        { value: "ITF14", label: "ITF-14（14 位数字）" },
      ],
    },
    { key: "value", label: "内容", kind: "text" },
    { key: "showText", label: "显示明文", kind: "check" },
    { key: "textSizeMm", label: "明文字高", kind: "num", min: 1.2, max: 8, step: 0.1, unit: "mm" },
  ],
  qrcode: [{ key: "value", label: "内容", kind: "area" }],
  rect: [
    { key: "filled", label: "实心", kind: "check" },
    { key: "strokeMm", label: "线宽", kind: "num", min: 0.1, max: 3, step: 0.1, unit: "mm" },
  ],
  line: [{ key: "thicknessMm", label: "线宽", kind: "num", min: 0.1, max: 3, step: 0.1, unit: "mm" }],
  image: [
    {
      key: "fit",
      label: "填充",
      kind: "select",
      options: [
        { value: "contain", label: "完整显示" },
        { value: "cover", label: "裁切铺满" },
        { value: "stretch", label: "拉伸铺满" },
      ],
    },
    { key: "threshold", label: "黑白阈值", kind: "range", min: 0, max: 255, step: 1 },
    { key: "dither", label: "抖动（照片用）", kind: "check" },
  ],
};

export const TYPE_LABEL: Record<string, string> = {
  text: "文字",
  barcode: "一维码",
  qrcode: "二维码",
  rect: "矩形",
  line: "线条",
  image: "图片",
};

/** 纸张预设。0×0 是"自定义"，选中它不触发换纸 */
export const PAPER_PRESETS: { label: string; w: number; h: number }[] = [
  { label: "自定义", w: 0, h: 0 },
  // B1 的纸仓最大 50mm，实测可打印也是 50mm，所以默认就是 50×30
  { label: "50×30（默认）", w: 50, h: 30 },
  { label: "50×40", w: 50, h: 40 },
  { label: "50×25", w: 50, h: 25 },
  { label: "48×30", w: 48, h: 30 },
  { label: "48×25", w: 48, h: 25 },
  { label: "40×30", w: 40, h: 30 },
  { label: "40×20", w: 40, h: 20 },
  { label: "30×15", w: 30, h: 15 },
  { label: "连续纸 50×80", w: 50, h: 80 },
];
