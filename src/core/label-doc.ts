/**
 * 标签文档模型
 * ------------------------------------------------------------------
 * 一张标签 = 纸张尺寸 + 一组元素。全部长度单位都是毫米，
 * 渲染时才按 dpi 换算成点，这样换机型（203dpi / 300dpi）不用改模板。
 *
 * 元素坐标 x/y 是**左上角**相对标签左上角的位置，
 * 与 CSS 的 left/top 一致，拖拽时不用额外做坐标变换。
 */

/** 元素种类 */
export type ElementType = "text" | "barcode" | "qrcode" | "rect" | "line" | "image";

/** 所有元素共有的字段 */
export interface BaseElement {
  id: string;
  type: ElementType;
  /** mm，左上角 */
  x: number;
  y: number;
  /** mm */
  w: number;
  h: number;
  /** 旋转角度，暂只支持 0 / 90 / 180 / 270 */
  rotate: 0 | 90 | 180 | 270;
  /** 是否参与打印（关掉后只在这个编辑器里看得见） */
  visible: boolean;
}

/** 文本 */
export interface TextElement extends BaseElement {
  type: "text";
  text: string;
  /** 字高(mm)，不是 pt */
  fontSizeMm: number;
  bold: boolean;
  /** 水平对齐 */
  align: "left" | "center" | "right";
  /** 垂直对齐（默认居中，与水平对齐配合即"框内居中"） */
  valign: "top" | "middle" | "bottom";
  /** 行距倍数 */
  lineHeight: number;
  /** 是否按外框宽度自动折行 */
  wrap: boolean;
}

/** 一维码 */
export interface BarcodeElement extends BaseElement {
  type: "barcode";
  format: "CODE128" | "CODE39" | "EAN13" | "ITF14";
  value: string;
  /** 是否在条码下面显示明文 */
  showText: boolean;
  /** 明文字高(mm) */
  textSizeMm: number;
}

/** 二维码 */
export interface QrCodeElement extends BaseElement {
  type: "qrcode";
  value: string;
}

/** 矩形 / 实心块 */
export interface RectElement extends BaseElement {
  type: "rect";
  filled: boolean;
  /** 线宽(mm)，仅空心时有意义 */
  strokeMm: number;
}

/** 横线或竖线 */
export interface LineElement extends BaseElement {
  type: "line";
  /** 线宽(mm) */
  thicknessMm: number;
}

/** 图片 / Logo */
export interface ImageElement extends BaseElement {
  type: "image";
  dataUrl: string;
  fit: "contain" | "cover" | "stretch";
  /** 二值化阈值 0~255，越小越容易变黑 */
  threshold: number;
  /** 是否用 Floyd-Steinberg 抖动（照片类图片打开，线条图关掉更干净） */
  dither: boolean;
}

export type LabelElement =
  | TextElement
  | BarcodeElement
  | QrCodeElement
  | RectElement
  | LineElement
  | ImageElement;

/** 纸张参数 */
export interface PaperSetup {
  /** 标签宽度(mm)，上限由打印头决定 */
  widthMm: number;
  /** 标签高度(mm)，即一张纸的走纸长度（间隙纸不含间隙） */
  heightMm: number;
  /** 打印机分辨率 */
  dpi: number;
  /** 打印头点数，384 对应 48mm @203dpi */
  printheadDots: number;
}

/** 一张标签的完整定义 */
export interface LabelDoc {
  version: 1;
  name: string;
  paper: PaperSetup;
  elements: LabelElement[];
}

/** 生成元素 id：不追求全局唯一，同一张标签内不重复就够 */
let idSeq = 0;
export function newId(prefix = "el"): string {
  idSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${idSeq}`;
}

/* ------------------------------------------------------------------ 默认值 */

const ZERO_BOX = { x: 0, y: 0, w: 30, h: 10, rotate: 0 as const, visible: true };

export function createText(partial: Partial<TextElement> = {}): TextElement {
  return {
    ...ZERO_BOX,
    id: newId("txt"),
    type: "text",
    text: "文字",
    fontSizeMm: 3.5,
    bold: false,
    // 默认上下左右都居中：新建元素和拖动改尺寸后，字都待在外框正中
    align: "center",
    valign: "middle",
    lineHeight: 1.3,
    wrap: false,
    w: 30,
    h: 6,
    ...partial,
  };
}

export function createBarcode(partial: Partial<BarcodeElement> = {}): BarcodeElement {
  return {
    ...ZERO_BOX,
    id: newId("bar"),
    type: "barcode",
    format: "CODE128",
    value: "SF20261024001",
    showText: true,
    textSizeMm: 2.2,
    w: 40,
    h: 14,
    ...partial,
  };
}

export function createQrCode(partial: Partial<QrCodeElement> = {}): QrCodeElement {
  return {
    ...ZERO_BOX,
    id: newId("qr"),
    type: "qrcode",
    value: "https://shuo.fun",
    w: 18,
    h: 18,
    ...partial,
  };
}

export function createRect(partial: Partial<RectElement> = {}): RectElement {
  return {
    ...ZERO_BOX,
    id: newId("rect"),
    type: "rect",
    filled: false,
    strokeMm: 0.4,
    w: 30,
    h: 12,
    ...partial,
  };
}

export function createLine(partial: Partial<LineElement> = {}): LineElement {
  return {
    ...ZERO_BOX,
    id: newId("line"),
    type: "line",
    thicknessMm: 0.5,
    w: 30,
    h: 0.5,
    ...partial,
  };
}

export function createImage(partial: Partial<ImageElement> = {}): ImageElement {
  return {
    ...ZERO_BOX,
    id: newId("img"),
    type: "image",
    dataUrl: "",
    fit: "contain",
    threshold: 128,
    dither: false,
    w: 20,
    h: 20,
    ...partial,
  };
}

/* ------------------------------------------------------------------ 模板 */

/** 空白标签 */
export function emptyDoc(paper: PaperSetup): LabelDoc {
  return { version: 1, name: "未命名", paper, elements: [] };
}

/**
 * 内置示例模板：一张常见的"物料标签"
 * 左边名称 + 规格，右上角二维码，底部条码
 */
export function sampleDoc(paper: PaperSetup): LabelDoc {
  const { widthMm, heightMm } = paper;
  return {
    version: 1,
    name: "物料标签",
    paper,
    elements: [
      createText({
        text: "物料名称",
        x: 2,
        y: 2,
        w: widthMm * 0.6,
        h: 5,
        fontSizeMm: 3.2,
        bold: true,
      }),
      createText({
        text: "规格型号",
        x: 2,
        y: 8,
        w: widthMm * 0.6,
        h: 4,
        fontSizeMm: 2.6,
      }),
      createText({
        text: "数量：100",
        x: 2,
        y: 13,
        w: widthMm * 0.6,
        h: 4,
        fontSizeMm: 2.6,
      }),
      createQrCode({
        x: widthMm - 20,
        y: 2,
        w: 17,
        h: 17,
        value: "SF-2026-001",
      }),
      createBarcode({
        x: 2,
        y: heightMm - 13,
        w: widthMm * 0.62,
        h: 11,
        value: "SF2026001",
        format: "CODE128",
        showText: true,
      }),
    ],
  };
}

/* ------------------------------------------------------------------ 存取 */

const STORE_KEY = "labelapp.templates.v1";

export interface SavedTemplate {
  name: string;
  doc: LabelDoc;
  savedAt: number;
}

/** 读取本地模板列表，失败一律当空（localStorage 可能被禁用/配额满） */
export function loadTemplates(): SavedTemplate[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as SavedTemplate[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** 保存一份模板，同名覆盖 */
export function saveTemplate(name: string, doc: LabelDoc): SavedTemplate[] {
  const list = loadTemplates().filter((t) => t.name !== name);
  list.unshift({ name, doc: { ...doc, name }, savedAt: Date.now() });
  const trimmed = list.slice(0, 30);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(trimmed));
  } catch {
    /* 存不下就算了，不影响打印 */
  }
  return trimmed;
}

export function deleteTemplate(name: string): SavedTemplate[] {
  const list = loadTemplates().filter((t) => t.name !== name);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
  return list;
}
