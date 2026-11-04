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

/** 本地最多存这么多份，超出的丢最旧的 */
const MAX_TEMPLATES = 30;

export interface SavedTemplate {
  name: string;
  doc: LabelDoc;
  savedAt: number;
}

/** saveTemplate 的结果：调用方据此提示"存进去了没有、有没有挤掉旧的" */
export interface SaveTemplateResult {
  /** 保存后完整的模板列表 */
  templates: SavedTemplate[];
  /** 是否真的写进了 localStorage */
  ok: boolean;
  /** 失败原因（配额不足等），ok=false 时有值 */
  error?: string;
  /** 是否因为超出上限丢掉了最旧的模板 */
  dropped: boolean;
}

function numOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 尺寸类字段：超出上下限就回退到默认值，而不是把用户数据夹成边界值 */
function dimOr(v: unknown, fallback: number, min: number, max: number): number {
  const n = numOr(v, fallback);
  return n >= min && n <= max ? n : fallback;
}

/**
 * 把磁盘上读到的 JSON 收敛成合法元素。
 * 老模板可能缺字段（valign、新增的 threshold…），也可能被手工改坏，
 * 这里逐字段兜底，类型不认识的元素直接丢掉，不让它污染渲染。
 */
function sanitizeElement(raw: unknown): LabelElement | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const type = r.type;
  if (typeof type !== "string") return null;

  const base: BaseElement = {
    id: typeof r.id === "string" && r.id ? r.id : newId(type),
    type: type as ElementType,
    x: numOr(r.x, 0),
    y: numOr(r.y, 0),
    w: Math.max(1, numOr(r.w, 30)),
    h: Math.max(1, numOr(r.h, 10)),
    rotate: ([0, 90, 180, 270].includes(Number(r.rotate)) ? Number(r.rotate) : 0) as
      | 0
      | 90
      | 180
      | 270,
    visible: r.visible !== false,
  };

  switch (type) {
    case "text":
      return createText({
        ...base,
        type: "text",
        text: typeof r.text === "string" ? r.text : "文字",
        fontSizeMm: Math.max(1, numOr(r.fontSizeMm, 3.5)),
        bold: Boolean(r.bold),
        align: r.align === "left" || r.align === "right" ? r.align : "center",
        valign: r.valign === "top" || r.valign === "bottom" ? r.valign : "middle",
        lineHeight: Math.max(1, numOr(r.lineHeight, 1.3)),
        wrap: Boolean(r.wrap),
      });
    case "barcode": {
      const formats = ["CODE128", "CODE39", "EAN13", "ITF14"];
      const fmt = typeof r.format === "string" && formats.includes(r.format) ? r.format : "CODE128";
      return createBarcode({
        ...base,
        type: "barcode",
        format: fmt as BarcodeElement["format"],
        value: typeof r.value === "string" ? r.value : "",
        showText: r.showText !== false,
        textSizeMm: Math.max(1, numOr(r.textSizeMm, 2.2)),
      });
    }
    case "qrcode":
      return createQrCode({
        ...base,
        type: "qrcode",
        value: typeof r.value === "string" ? r.value : "",
      });
    case "rect":
      return createRect({
        ...base,
        type: "rect",
        filled: Boolean(r.filled),
        strokeMm: Math.max(0.1, numOr(r.strokeMm, 0.4)),
      });
    case "line":
      return createLine({
        ...base,
        type: "line",
        thicknessMm: Math.max(0.1, numOr(r.thicknessMm, 0.5)),
      });
    case "image":
      return createImage({
        ...base,
        type: "image",
        dataUrl: typeof r.dataUrl === "string" ? r.dataUrl : "",
        fit: r.fit === "cover" || r.fit === "stretch" ? r.fit : "contain",
        threshold: Math.min(255, Math.max(0, numOr(r.threshold, 128))),
        dither: Boolean(r.dither),
      });
    default:
      return null;
  }
}

/** 把读到的文档收敛成合法文档；结构完全不可用时返回 null */
export function sanitizeDoc(raw: unknown, fallbackName = "未命名"): LabelDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!r.paper || typeof r.paper !== "object") return null;
  const p = r.paper as Record<string, unknown>;
  const dpi = numOr(p.dpi, 203);
  const printheadDots = Math.max(1, numOr(p.printheadDots, 400));
  const paper: PaperSetup = {
    widthMm: dimOr(p.widthMm, 50, 5, 200),
    heightMm: dimOr(p.heightMm, 30, 5, 300),
    dpi,
    printheadDots,
  };
  const elements = Array.isArray(r.elements)
    ? r.elements.map(sanitizeElement).filter((e): e is LabelElement => e !== null)
    : [];
  return {
    version: 1,
    name: typeof r.name === "string" && r.name ? r.name : fallbackName,
    paper,
    elements,
  };
}

/** 读取本地模板列表，失败一律当空（localStorage 可能被禁用/配额满） */
export function loadTemplates(): SavedTemplate[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    // 载入时逐条校验：坏掉的条目直接丢弃，不让它把整个列表带崩
    return list
      .map((item): SavedTemplate | null => {
        if (!item || typeof item !== "object") return null;
        const t = item as Record<string, unknown>;
        if (typeof t.name !== "string" || !t.name) return null;
        const doc = sanitizeDoc(t.doc, t.name);
        if (!doc) return null;
        return { name: t.name, doc, savedAt: numOr(t.savedAt, 0) };
      })
      .filter((t): t is SavedTemplate => t !== null);
  } catch {
    return [];
  }
}

/** 保存一份模板，同名覆盖 */
export function saveTemplate(name: string, doc: LabelDoc): SaveTemplateResult {
  const prev = loadTemplates();
  const list = prev.filter((t) => t.name !== name);
  list.unshift({ name, doc: { ...doc, name }, savedAt: Date.now() });
  const dropped = list.length > MAX_TEMPLATES;
  const trimmed = list.slice(0, MAX_TEMPLATES);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(trimmed));
  } catch (e) {
    /* 配额满（带图片的模板很容易超 5MB）时不能静默失败，要让界面提示 */
    return {
      templates: prev,
      ok: false,
      error: `本地存储空间不足（${(e as Error).message}），带图片的模板请先导出或换一台设备保存`,
      dropped: false,
    };
  }
  return { templates: trimmed, ok: true, dropped };
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
