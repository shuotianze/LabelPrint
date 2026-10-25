/**
 * 标签编辑器
 * ------------------------------------------------------------------
 * 交互部分全部手写，不引入任何 UI 框架：
 *
 *   .stage            固定尺寸的舞台，里面放 canvas
 *   canvas            真正的打印内容，尺寸 = 打印头点数 × 纸高点数
 *   .overlay          绝对定位盖在 canvas 上，每个元素一个虚线框，负责命中/拖拽/缩放
 *
 * 为什么用 DOM 框而不是在 canvas 里画选择框：
 * 命中测试、指针捕获、键盘焦点这些浏览器都帮我们做了，
 * 而且框和 canvas 的位置用同一套 mm→px 换算，不会对不上。
 */
import {
  createBarcode,
  createImage,
  createLine,
  createQrCode,
  createRect,
  createText,
  newId,
  type BarcodeElement,
  type ImageElement,
  type LabelDoc,
  type LabelElement,
  type LineElement,
  type QrCodeElement,
  type RectElement,
  type TextElement,
} from "../core/label-doc";
import { dotsPerMm, round1 } from "../core/units";
import {
  centerInContainer,
  centerOf,
  containerOf,
  MIN_WIDTH_MM,
  placeByCenter,
  resizeKeepCenter,
} from "../core/align";
import {
  canvasSizeOf,
  createCache,
  printableMmOf,
  renderLabel,
  type RenderCache,
} from "../render/render-label";

/* ------------------------------------------------------------------ 表单描述 */

interface FieldDef {
  key: string;
  label: string;
  kind: "num" | "text" | "area" | "select" | "check" | "range";
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  unit?: string;
}

const COMMON: FieldDef[] = [
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

const FIELDS: Record<string, FieldDef[]> = {
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

const TYPE_LABEL: Record<string, string> = {
  text: "文字",
  barcode: "一维码",
  qrcode: "二维码",
  rect: "矩形",
  line: "线条",
  image: "图片",
};

/* ------------------------------------------------------------------ 编辑器 */

export interface EditorHooks {
  /** 文档变化（含拖拽、改属性、增删元素） */
  onChange?: (doc: LabelDoc) => void;
  /** 需要用户从磁盘选一张图 */
  pickImage?: () => Promise<string | null>;
  /** 状态栏文字 */
  notify?: (msg: string, isError?: boolean) => void;
  /** 选中的元素变了（手机端据此弹出/收起属性面板） */
  onSelect?: (id: string | null) => void;
}

export class LabelEditor {
  private doc: LabelDoc;
  private cache: RenderCache = createCache();
  private zoom = 1;
  private selectedId: string | null = null;
  /** 面板何时需要重建：只在选中变化/结构变化时重建，拖动时重建会打断输入焦点 */
  private panelDirty = true;
  /** 渲染队列：正在画的时候再来的改动只做标记，画完补一轮，避免并发抢 canvas */
  private rendering = false;
  private needRender = true;
  private canvas: HTMLCanvasElement;
  private overlay: HTMLElement;
  private inspector: HTMLElement;
  private hooks: EditorHooks;
  /** 纸张输入控件，改纸时只回写数字，不重建面板（否则输入框焦点丢失） */
  private paperInputs?: {
    w: HTMLInputElement;
    h: HTMLInputElement;
    info: HTMLElement;
    limit: HTMLElement;
    head: HTMLSelectElement;
    preset: HTMLSelectElement;
  };
  /** 开始编辑纸张数字那一刻的纸型，失焦时用它算缩放比 */
  private paperEditBase: { w: number; h: number } | null = null;

  constructor(opts: {
    canvas: HTMLCanvasElement;
    overlay: HTMLElement;
    inspector: HTMLElement;
    doc: LabelDoc;
    hooks?: EditorHooks;
  }) {
    this.canvas = opts.canvas;
    this.overlay = opts.overlay;
    this.inspector = opts.inspector;
    this.doc = opts.doc;
    this.hooks = opts.hooks ?? {};

    // 点空白处取消选中
    this.overlay.addEventListener("pointerdown", (e) => {
      if (e.target === this.overlay) this.select(null);
    });

    // Delete / Backspace 删除，方向键微调
    window.addEventListener("keydown", (e) => {
      const el = this.selected();
      if (!el) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        this.remove(el.id);
        return;
      }
      const step = e.shiftKey ? 1 : 0.1;
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const mv = moves[e.key];
      if (mv) {
        e.preventDefault();
        el.x = round1(el.x + mv[0]);
        el.y = round1(el.y + mv[1]);
        this.commit();
      }
    });

    void this.pump();
    // 首帧也要报一次尺寸，否则工具栏上的"纸张 × 点数"一直是空的
    this.hooks.onChange?.(this.doc);
  }

  /* ------------------------------------------------------------ 基本存取 */

  getDoc(): LabelDoc {
    return this.doc;
  }

  setDoc(doc: LabelDoc) {
    this.doc = doc;
    this.selectedId = null;
    this.cache = createCache();
    this.commit(true);
  }

  setZoom(z: number) {
    this.zoom = Math.min(3, Math.max(0.4, z));
    this.commit();
  }

  getZoom(): number {
    return this.zoom;
  }

  get ppm(): number {
    return dotsPerMm(this.doc.paper.dpi) * this.zoom;
  }

  selected(): LabelElement | undefined {
    return this.doc.elements.find((e) => e.id === this.selectedId);
  }

  select(id: string | null) {
    this.selectedId = id;
    this.commit(true);
    this.hooks.onSelect?.(id);
  }

  /**
   * 把整个舞台缩放到刚好放进 px 宽的容器里（手机竖屏用）。
   * 宽度取"画布宽"和"纸宽"的较大者：纸比打印头宽时右侧还有斜纹区，
   * 只按画布算会让斜纹条顶出屏幕。
   */
  fitToWidth(px: number) {
    if (!(px > 0)) return;
    const { width } = canvasSizeOf(this.doc);
    const paperDots = this.doc.paper.widthMm * dotsPerMm(this.doc.paper.dpi);
    const natural = Math.max(width, paperDots);
    if (!natural) return;
    const z = Math.min(3, Math.max(0.4, px / natural));
    // 避免 0.001 级的抖动反复触发重绘
    if (Math.abs(z - this.zoom) < 0.01) return;
    this.setZoom(z);
  }

  /* ------------------------------------------------------------ 增删 */

  add(type: LabelElement["type"]) {
    const paper = this.doc.paper;
    const cx = round1(Math.max(0, paper.widthMm / 2));
    const cy = round1(Math.max(0, paper.heightMm / 2));

    let el: LabelElement;
    switch (type) {
      case "text":
        el = createText({ x: 2, y: 2 });
        /* 新建文字默认"宽 30、中心对准纸中心"。
         * 放在这是为了让 30 → 50 改宽度时中心真的不动（示例见 README）。 */
        placeByCenter(el, { containerMm: containerOf(paper), centerMm: containerOf(paper) / 2 });
        break;
      case "barcode":
        el = createBarcode({
          x: 2,
          y: Math.max(0, paper.heightMm - 16),
          w: Math.min(40, paper.widthMm - 4),
        });
        break;
      case "qrcode":
        el = createQrCode({ x: Math.max(0, paper.widthMm - 22), y: 2, w: 18, h: 18 });
        break;
      case "rect":
        el = createRect({ x: Math.max(0, cx - 15), y: Math.max(0, cy - 6) });
        break;
      case "line":
        el = createLine({ x: 2, y: cy, w: Math.max(10, paper.widthMm - 4) });
        break;
      case "image":
        el = createImage({ x: Math.max(0, cx - 10), y: Math.max(0, cy - 10) });
        break;
    }

    this.doc.elements.push(el);
    this.selectedId = el.id;
    this.commit(true);
    // 新建后自动选中，手机端要跟着弹出属性面板（否则加完元素找不到参数在哪）
    this.hooks.onSelect?.(el.id);
    if (type === "image") void this.pickImageFor(el as ImageElement);
  }

  remove(id: string) {
    this.doc.elements = this.doc.elements.filter((e) => e.id !== id);
    if (this.selectedId === id) this.selectedId = null;
    this.commit(true);
  }

  duplicate(id: string) {
    const src = this.doc.elements.find((e) => e.id === id);
    if (!src) return;
    // 结构化克隆会把 id 一起带过来，必须换新 id
    const copy: LabelElement = { ...JSON.parse(JSON.stringify(src)), id: newId(src.type) };
    copy.x = round1(copy.x + 2);
    copy.y = round1(copy.y + 2);
    this.doc.elements.push(copy);
    this.selectedId = copy.id;
    this.commit(true);
  }

  moveLayer(id: string, delta: number) {
    const i = this.doc.elements.findIndex((e) => e.id === id);
    if (i < 0) return;
    const j = i + delta;
    if (j < 0 || j >= this.doc.elements.length) return;
    const [item] = this.doc.elements.splice(i, 1);
    this.doc.elements.splice(j, 0, item);
    this.commit(true);
  }

  /** 纸张尺寸变了，元素不用挪，但画布要重算 */
  setPaperSize(patch: Partial<LabelDoc["paper"]>) {
    this.doc.paper = { ...this.doc.paper, ...patch };
    /* 这里**不能**重建属性面板（commit(true)）。
     * 面板一重建，正在输入的 input 就被换掉了，焦点丢失：
     * 想输"50"只能输进去"5"，第二位数字不知跑到哪去——就是"设不了 50"的真凶。
     * 所以只刷新数字和画布，控件本身留着。 */
    this.syncPaperInputs();
    this.commit();
  }

  /**
   * 换纸型：纸张尺寸改掉，同时把整版内容按比例搬过去。
   * ------------------------------------------------------------------
   * 只改纸宽、不动内容的话，48mm 和 50mm 打出来是同一张东西
   * （模板本来就只用到 46mm 宽），用户会觉得"这个参数根本没用"。
   * 缩放之后文字、行距、二维码都跟着纸走，换纸＝真的换了一张排版。
   * 字号按两个方向里较小的比例缩，避免纸变长时出现"巨型字配小框"。
   */
  setPaperSizeScaled(widthMm: number, heightMm: number) {
    const prev = this.doc.paper;
    const w = Math.max(5, round1(widthMm));
    const h = Math.max(5, round1(heightMm));
    const sx = w / prev.widthMm;
    const sy = h / prev.heightMm;
    if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) return;

    if (Math.abs(sx - 1) > 0.004 || Math.abs(sy - 1) > 0.004) {
      this.scaleElements(sx, sy, w, h);
      this.hooks.notify?.(
        `纸张 ${w}×${h}mm，内容按 ${Math.round(Math.min(sx, sy) * 100)}% 等比缩放`
      );
    }
    this.doc.paper = { ...prev, widthMm: w, heightMm: h };
    this.syncPaperInputs();
    this.commit();
  }

  /** 把所有元素的坐标/尺寸按 sx、sy 缩放，字号按两者较小的比例缩放 */
  private scaleElements(sx: number, sy: number, targetW: number, targetH: number) {
    const sf = Math.min(sx, sy);
    for (const el of this.doc.elements) {
      el.x = round1(el.x * sx);
      el.y = round1(el.y * sy);
      el.w = round1(el.w * sx);
      el.h = round1(el.h * sy);

      if (el.type === "text") el.fontSizeMm = Math.max(1.2, round1(el.fontSizeMm * sf));
      if (el.type === "barcode") el.textSizeMm = Math.max(1.2, round1(el.textSizeMm * sf));
      if (el.type === "rect") el.strokeMm = Math.max(0.1, round1(el.strokeMm * sf));
      if (el.type === "line") {
        el.thicknessMm = Math.max(0.12, round1(el.thicknessMm * sf));
        // 线宽存在"短边"里，缩放后重新对齐，否则线会变粗或消失
        if (el.w >= el.h) el.h = el.thicknessMm;
        else el.w = el.thicknessMm; // 竖线：短边是宽
      }
      if (el.type === "qrcode") {
        // 二维码必须保持正方形，否则模组变矩形扫不出来
        const side = round1(Math.min(el.w, el.h));
        el.x = round1(el.x + (el.w - side) / 2);
        el.y = round1(el.y + (el.h - side) / 2);
        el.w = side;
        el.h = side;
      }

      // 兜底：任何元素都不许跑到纸外
      el.x = Math.max(0, Math.min(el.x, targetW - 1));
      el.y = Math.max(0, Math.min(el.y, targetH - 1));
      el.w = Math.max(1, Math.min(el.w, targetW - el.x));
      el.h = Math.max(1, Math.min(el.h, targetH - el.y));
    }
  }

  /** 输入框改完（失焦/回车）后按新纸型缩放一次版式 */
  private applyPaperEdit() {
    const base = this.paperEditBase;
    this.paperEditBase = null;
    if (!base) return;
    const p = this.doc.paper;
    const sx = p.widthMm / base.w;
    const sy = p.heightMm / base.h;
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) return;
    if (Math.abs(sx - 1) <= 0.004 && Math.abs(sy - 1) <= 0.004) return;

    this.scaleElements(sx, sy, p.widthMm, p.heightMm);
    this.hooks.notify?.(
      `纸张 ${p.widthMm}×${p.heightMm}mm，内容按 ${Math.round(Math.min(sx, sy) * 100)}% 等比缩放`
    );
    this.commit();
  }

  /** 打印头实际能打到的最宽毫米数。向下取到 0.1，绝不能四舍五入（会超出打印头 1 个点） */
  maxWidthMm(): number {
    const raw = (this.doc.paper.printheadDots * 25.4) / this.doc.paper.dpi;
    return Math.floor(raw * 10) / 10;
  }

  /** 这一页真正能打多宽（mm）：纸宽和打印头取小的那个 */
  printableWidthMm(): number {
    return printableMmOf(this.doc.paper);
  }

  /* ------------------------------------------------------------ 渲染 */

  /* 不用 requestAnimationFrame 做节流。
   * 它在窗口不可见、后台标签页、无头浏览器里可能完全不触发，
   * 一旦不触发，这里就会永久卡住不再重绘（实测出现过"改纸张没反应"）。
   * 改成显式的渲染队列：正在画就只打标记，画完自动补一轮，行为可预测。 */
  private commit(rebuildPanel = false) {
    if (rebuildPanel) this.panelDirty = true;
    this.needRender = true;
    void this.pump();
    this.hooks.onChange?.(this.doc);
  }

  private async pump() {
    if (this.rendering) return;
    this.rendering = true;
    try {
      // while 而不是 if：渲染过程中可能又有新改动进来，必须再画一遍
      while (this.needRender) {
        this.needRender = false;
        await this.render();
      }
    } finally {
      this.rendering = false;
    }
  }

  private async render() {
    const { width, height } = canvasSizeOf(this.doc);
    const canvasW = Math.round(width * this.zoom);
    const canvasH = Math.round(height * this.zoom);
    /* 纸比打印头宽时，画布右边还要留出一条"打不到"的区域，
     * 舞台宽度按纸的实际宽度算，否则用户看不到自己设的 50mm 在哪。 */
    const paperW = Math.round(this.doc.paper.widthMm * dotsPerMm(this.doc.paper.dpi) * this.zoom);
    const stageW = Math.max(canvasW, paperW);

    this.canvas.style.width = `${canvasW}px`;
    this.canvas.style.height = `${canvasH}px`;
    this.overlay.style.width = `${stageW}px`;
    this.overlay.style.height = `${canvasH}px`;
    // 舞台跟着纸走，斜纹区看起来才是"纸的一部分"，而不是飘在纸外面
    const stage = this.canvas.parentElement;
    if (stage) {
      stage.style.width = `${stageW}px`;
      stage.style.height = `${canvasH}px`;
    }

    await renderLabel(this.canvas, this.doc, this.cache);
    this.syncDeadZone(canvasW, canvasH, stageW);
    this.syncBoxes();
    if (this.panelDirty) {
      this.panelDirty = false;
      this.buildInspector();
    }
  }

  /** 在画布右侧画出"打不到"的斜纹条；纸宽没超过打印头时自动移除 */
  private syncDeadZone(canvasW: number, canvasH: number, stageW: number) {
    let dz = this.overlay.querySelector<HTMLElement>(".dead-zone");
    const gapW = stageW - canvasW;

    if (gapW < 2) {
      dz?.remove();
      return;
    }
    if (!dz) {
      dz = document.createElement("div");
      dz.className = "dead-zone";
      const tag = document.createElement("span");
      tag.textContent = "打不到";
      dz.appendChild(tag);
      this.overlay.prepend(dz);
    }
    dz.style.left = `${canvasW}px`;
    dz.style.width = `${gapW}px`;
    dz.style.height = `${canvasH}px`;
  }

  /** 让每个元素框跟上文档里的坐标 */
  private syncBoxes() {
    const ppm = this.ppm;
    const ids = new Set(this.doc.elements.map((e) => e.id));

    for (const node of Array.from(this.overlay.children)) {
      const box = node as HTMLElement;
      // 斜纹条不是元素框，不能被当成"已经删掉的元素"清掉
      if (box.classList.contains("dead-zone")) continue;
      if (!ids.has(box.dataset.id ?? "")) box.remove();
    }

    for (const el of this.doc.elements) {
      let box = this.overlay.querySelector<HTMLElement>(`[data-id="${el.id}"]`);
      if (!box) {
        box = document.createElement("div");
        box.className = "el-box";
        box.dataset.id = el.id;
        this.bindBox(box, el.id);
        this.overlay.appendChild(box);
      }
      box.classList.toggle("selected", el.id === this.selectedId);
      box.classList.toggle("hidden-el", !el.visible);
      box.style.left = `${el.x * ppm}px`;
      box.style.top = `${el.y * ppm}px`;
      box.style.width = `${Math.max(6, el.w * ppm)}px`;
      box.style.height = `${Math.max(6, el.h * ppm)}px`;

      // 右下角缩放手柄，只在选中时插入
      let grip = box.querySelector<HTMLElement>(".grip");
      if (el.id === this.selectedId) {
        if (!grip) {
          grip = document.createElement("div");
          grip.className = "grip";
          this.bindGrip(grip, el.id);
          box.appendChild(grip);
        }
      } else if (grip) {
        grip.remove();
      }
    }
  }

  /* ------------------------------------------------------------ 拖拽 */

  private bindBox(box: HTMLElement, id: string) {
    box.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.select(id);

      const el = this.doc.elements.find((x) => x.id === id);
      if (!el) return;

      const ppm = this.ppm;
      const startX = e.clientX;
      const startY = e.clientY;
      const originX = el.x;
      const originY = el.y;
      /* 捕获指针是为了"手指滑出框外也继续拖动"。
       * 但合成事件（自动化测试）或指针已失效时这里会抛 NotFoundError，
       * 一旦抛出去就会中断整个 pointerdown，真机上也可能是白屏错误页。
       * 抓不到就退化成普通拖动，不影响选中和拖拽。 */
      try {
        box.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }

      const onMove = (ev: PointerEvent) => {
        const dx = (ev.clientX - startX) / ppm;
        const dy = (ev.clientY - startY) / ppm;
        // 吸附到 0.1mm，避免存进模板里一堆 12.837461 这种数
        el.x = Math.max(0, round1(originX + dx));
        el.y = Math.max(0, round1(originY + dy));
        this.commit();
      };
      const onUp = () => {
        box.removeEventListener("pointermove", onMove);
        box.removeEventListener("pointerup", onUp);
        box.removeEventListener("pointercancel", onUp);
      };
      box.addEventListener("pointermove", onMove);
      box.addEventListener("pointerup", onUp);
      box.addEventListener("pointercancel", onUp);
    });

    /* 双击元素 = 选中 + 直接把光标放进"内容"框。
     * 手机上长按是系统保留动作（文本选择/放大镜），抢不过来也不该抢，
     * 与其让用户猜"要长按吗"，不如给一个明确的双击入口。 */
    box.addEventListener("dblclick", () => {
      this.select(id);
      // select() 会整块重建属性面板，输入框要等这一帧挂上 DOM 才能聚焦
      requestAnimationFrame(() => this.focusContentField());
    });
  }

  /** 把焦点送进当前元素的内容输入框（没有内容字段的元素返回 false） */
  private focusContentField(): boolean {
    const ta = this.inspector.querySelector<HTMLTextAreaElement>(".fields textarea");
    if (!ta) return false;
    ta.scrollIntoView({ block: "center" });
    ta.focus();
    const end = ta.value.length;
    try {
      ta.setSelectionRange(end, end);
    } catch {
      /* 有些 WebView 对未挂载的输入框会抛，忽略即可 */
    }
    return true;
  }

  private bindGrip(grip: HTMLElement, id: string) {
    grip.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      const el = this.doc.elements.find((x) => x.id === id);
      if (!el) return;

      const ppm = this.ppm;
      const startX = e.clientX;
      const startY = e.clientY;
      const ow = el.w;
      const oh = el.h;
      // 缩放全程守住这个中心：左右两边对称伸缩，中心 X 不动
      const centerX = centerOf(el);
      try {
        grip.setPointerCapture(e.pointerId);
      } catch {
        /* 同上：抓不到指针也照常缩放手柄 */
      }

      const onMove = (ev: PointerEvent) => {
        const box = containerOf(this.doc.paper);
        /* 手柄在右边，鼠标右移 dx 时右边 +dx、左边 -dx，
         * 所以宽度变化是 2 倍 dx——这样手柄始终跟着指针，中心不动。 */
        const nextW = Math.min(
          box,
          Math.max(MIN_WIDTH_MM, round1(ow + ((ev.clientX - startX) / ppm) * 2))
        );
        placeByCenter(el, { widthMm: nextW, centerMm: centerX, containerMm: box });
        el.h = Math.max(1, round1(oh + (ev.clientY - startY) / ppm));
        this.commit();
      };
      const onUp = () => {
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        grip.removeEventListener("pointercancel", onUp);
      };
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
      grip.addEventListener("pointercancel", onUp);
    });
  }

  /* ------------------------------------------------------------ 属性面板 */

  /**
   * 手机单栏布局的断点。必须和 styles.css 里 @media (max-width: 860px) 保持一致，
   * 否则会出现"面板已经变抽屉、内容却还按桌面顺序排"的错位。
   */
  private isCompact(): boolean {
    return typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 860px)").matches
      : false;
  }

  private buildInspector() {
    const root = this.inspector;
    root.textContent = "";

    const el = this.selected();

    /* 手机上属性面板是从底部弹出的，只占 62vh。纸张设置（纸型/宽/高/点数）
     * 一排下来就把"内容"输入框顶到看不见的地方了 —— 用户会以为得长按才能编辑。
     * 所以窄屏把元素区提到最前面，桌面保持"纸张在上"的原顺序。 */
    if (el && this.isCompact()) {
      root.appendChild(this.elementSection(el));
      root.appendChild(this.paperSection());
      return;
    }

    root.appendChild(this.paperSection());

    if (!el) {
      const tip = document.createElement("p");
      tip.className = "hint mt";
      tip.textContent = "点画布上的元素可以改属性；没有元素时这里只显示纸张设置。";
      root.appendChild(tip);
      return;
    }

    root.appendChild(this.elementSection(el));
  }

  /** 选中元素的属性区（标题 + 字段 + 按钮），桌面上排在纸张设置之后 */
  private elementSection(el: LabelElement): HTMLElement {
    const wrap = document.createElement("div");

    const title = document.createElement("h2");
    title.className = "mt";
    title.textContent = `元素 · ${TYPE_LABEL[el.type] ?? el.type}`;
    wrap.appendChild(title);

    const fields = [...COMMON, ...(FIELDS[el.type] ?? [])];
    /* 窄屏把"内容"（多行框）拎到字段最前，面板一弹出就能直接打字。
     * sort 是稳定的，其余字段顺序不变。 */
    if (this.isCompact()) {
      fields.sort((a, b) => Number(b.kind === "area") - Number(a.kind === "area"));
    }
    const form = document.createElement("div");
    form.className = "fields";
    for (const f of fields) form.appendChild(this.fieldRow(el, f));
    wrap.appendChild(form);

    if (el.type === "image") {
      const btn = document.createElement("button");
      btn.textContent = "重新选择图片";
      btn.style.width = "100%";
      btn.className = "mt";
      btn.onclick = () => void this.pickImageFor(el as ImageElement);
      wrap.appendChild(btn);
    }

    const actions = document.createElement("div");
    actions.className = "row-actions mt";

    const mkBtn = (label: string, fn: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = fn;
      return b;
    };

    /* 一键把元素摆到纸的正中：中心 X = 纸宽 / 2，
     * 元素宽度不同也能对齐到同一条中心线（30 宽 → 左 10，50 宽 → 左 0）。 */
    const alignRow = document.createElement("div");
    alignRow.className = "row-actions mt";
    alignRow.appendChild(
      mkBtn("水平居中", () => {
        const res = centerInContainer(el, this.doc.paper);
        this.hooks.notify?.(
          `已居中：中心 X=${res.centerX}mm，左 ${res.left} / 右 ${res.right}（宽 ${res.widthMm}mm）`
        );
        this.commit(true);
      })
    );
    wrap.appendChild(alignRow);

    actions.append(
      mkBtn("上移图层", () => this.moveLayer(el.id, 1)),
      mkBtn("下移图层", () => this.moveLayer(el.id, -1)),
      mkBtn("复制", () => this.duplicate(el.id)),
      mkBtn("删除", () => this.remove(el.id))
    );
    wrap.appendChild(actions);

    return wrap;
  }

  /** 纸张设置：不选中元素时也能改，随时可用 */
  private paperSection(): HTMLElement {
    const wrap = document.createElement("div");

    const h = document.createElement("h2");
    h.textContent = "纸张";
    wrap.appendChild(h);

    const preset = document.createElement("select");
    preset.innerHTML = "";
    /* B1 的纸仓最大 50mm，实测可打印也是 50mm，所以默认就是 50×30。
     * 选预设＝换纸型，内容会跟着等比缩放（见 setPaperSizeScaled）。 */
    const presets = [
      { label: "自定义", w: 0, h: 0 },
      { label: "B1 50×30（默认）", w: 50, h: 30 },
      { label: "B1 50×40", w: 50, h: 40 },
      { label: "50×25", w: 50, h: 25 },
      { label: "48×30", w: 48, h: 30 },
      { label: "48×25", w: 48, h: 25 },
      { label: "40×30", w: 40, h: 30 },
      { label: "40×20", w: 40, h: 20 },
      { label: "30×15", w: 30, h: 15 },
      { label: "连续纸 50×80", w: 50, h: 80 },
    ];
    for (const p of presets) {
      const o = document.createElement("option");
      o.value = `${p.w}x${p.h}`;
      o.textContent = p.label;
      preset.appendChild(o);
    }
    preset.onchange = () => {
      const [w, h2] = preset.value.split("x").map(Number);
      if (w > 0 && h2 > 0) this.setPaperSizeScaled(w, h2);
      else preset.value = `${this.doc.paper.widthMm}x${this.doc.paper.heightMm}`;
    };
    wrap.appendChild(this.labelWrap("纸型", preset));

    const wInput = this.paperDimInput("w");
    const hInput = this.paperDimInput("h");

    const row = document.createElement("div");
    row.className = "row";
    row.append(this.labelWrap("宽", wInput, "mm"), this.labelWrap("高", hInput, "mm"));
    wrap.appendChild(row);

    /* 打印头点数＝整机上限，画布宽度取"纸宽"和它里面小的那个。
     * B1 机型表写 384 点（48mm），但这台实测能打满 50mm（400 点），
     * 默认 400；万一打出来右边被切，切回 384 就会按 48mm 出图。 */
    const headSel = document.createElement("select");
    for (const opt of [
      { v: 400, label: "400 点（50mm · 实测满宽）" },
      { v: 384, label: "384 点（48mm · 机型表）" },
    ]) {
      const o = document.createElement("option");
      o.value = String(opt.v);
      o.textContent = opt.label;
      headSel.appendChild(o);
    }
    headSel.value = String(this.doc.paper.printheadDots);
    headSel.onchange = () => {
      this.setPaperSize({ printheadDots: Number(headSel.value) });
      this.syncPaperInputs();
    };
    wrap.appendChild(this.labelWrap("打印头", headSel));

    const info = document.createElement("p");
    info.className = "hint";
    wrap.appendChild(info);

    const limit = document.createElement("p");
    limit.className = "hint";
    wrap.appendChild(limit);

    this.paperInputs = { w: wInput, h: hInput, info, limit, head: headSel, preset };
    // 面板刚建好时把下拉/提示对齐到当前值（预设项要选中，不然显示"自定义"）
    this.syncPaperInputs();

    // 缩放只是显示比例，不改变打印内容，所以放在纸张区块最后
    const zoom = document.createElement("input");
    zoom.type = "range";
    zoom.min = "0.4";
    zoom.max = "2.5";
    zoom.step = "0.1";
    zoom.value = String(this.zoom);
    const zval = document.createElement("i");
    zval.textContent = `${Math.round(this.zoom * 100)}%`;
    zoom.oninput = () => {
      this.setZoom(Number(zoom.value));
      zval.textContent = `${Math.round(this.zoom * 100)}%`;
    };
    wrap.appendChild(this.labelWrap("缩放", zoom)).appendChild(zval);

    return wrap;
  }

  /**
   * 纸张宽/高输入框。
   * 两个时机分开处理，缺一不可：
   *   input  实时改纸（画布马上变宽变窄，手感直观），但**不**缩放内容；
   *   change 失焦/回车时才按比例缩放整版内容。
   * 如果 input 就缩放，输"50"会先按"5"缩一次再按"50"缩一次，版式被越缩越小。
   */
  private paperDimInput(kind: "w" | "h"): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "number";
    input.step = "1";
    input.min = "5";
    input.max = kind === "w" ? "200" : "300";
    input.value = String(kind === "w" ? this.doc.paper.widthMm : this.doc.paper.heightMm);

    input.addEventListener("focus", () => {
      this.paperEditBase = { w: this.doc.paper.widthMm, h: this.doc.paper.heightMm };
    });

    input.addEventListener("input", () => {
      const v = Number(input.value);
      if (!Number.isFinite(v) || v < 5) return;
      if (kind === "w") {
        this.setPaperSize({ widthMm: v });
        const head = this.maxWidthMm();
        // 设得比打印头宽不拦，只提示：直接拒绝，用户会以为程序坏了
        if (v > head + 0.05) {
          this.hooks.notify?.(
            `纸宽 ${v}mm，当前可打印只有 ${head}mm：右侧 ${(v - head).toFixed(1)}mm 打不到（预览里已标斜纹）`
          );
        }
      } else {
        this.setPaperSize({ heightMm: v });
      }
    });

    input.addEventListener("change", () => {
      this.applyPaperEdit();
      // 失焦时把输入框纠正成真实生效值（比如被夹到下限）
      input.value = String(kind === "w" ? this.doc.paper.widthMm : this.doc.paper.heightMm);
    });

    return input;
  }

  /** 改纸后回写数字与提示，不碰 DOM 结构，避免正在输入的框被换掉 */
  private syncPaperInputs() {
    const p = this.paperInputs;
    if (!p) return;
    // 正在输入的框不要硬改，否则光标会跳；失焦时由 change 事件纠正
    if (document.activeElement !== p.w) p.w.value = String(this.doc.paper.widthMm);
    if (document.activeElement !== p.h) p.h.value = String(this.doc.paper.heightMm);
    if (document.activeElement !== p.head) p.head.value = String(this.doc.paper.printheadDots);
    /* 预设下拉跟着当前尺寸走：尺寸对得上就选中对应项，对不上就落到"自定义"。
     * 不这么做的话，文件里存的是 50×30，下拉却永远显示"自定义"，看着像没生效。 */
    if (document.activeElement !== p.preset) {
      const key = `${this.doc.paper.widthMm}x${this.doc.paper.heightMm}`;
      p.preset.value = Array.from(p.preset.options).some((o) => o.value === key) ? key : "0x0";
    }
    const { width, height } = canvasSizeOf(this.doc);
    const realW = this.printableWidthMm();
    p.info.textContent = `${width}×${height} 点 · ${realW.toFixed(1)}×${this.doc.paper.heightMm}mm @${this.doc.paper.dpi}dpi`;
    p.limit.textContent =
      this.doc.paper.widthMm > realW + 0.05
        ? `打印头只有 ${this.maxWidthMm()}mm，右侧 ${(this.doc.paper.widthMm - realW).toFixed(1)}mm 打不到`
        : `打印头 ${this.doc.paper.printheadDots} 点 = ${this.maxWidthMm()}mm，本页用满`;
  }


  private labelWrap(text: string, node: HTMLElement, unit?: string): HTMLElement {
    const row = document.createElement("label");
    row.className = "field";
    const span = document.createElement("span");
    span.textContent = text;
    row.append(span, node);
    if (unit) {
      const u = document.createElement("i");
      u.textContent = unit;
      row.appendChild(u);
    }
    return row;
  }

  private numInput(
    value: number,
    step: number,
    min: number,
    max: number,
    _precision: number,
    apply: (v: number) => void
  ): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "number";
    input.step = String(step);
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    input.oninput = () => {
      const v = Number(input.value);
      if (Number.isFinite(v)) apply(v);
    };
    return input;
  }

  private fieldRow(el: LabelElement, f: FieldDef): HTMLElement {
    const rec = el as unknown as Record<string, unknown>;

    if (f.kind === "check") {
      const label = document.createElement("label");
      label.className = "field check-row";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = Boolean(rec[f.key]);
      input.onchange = () => {
        rec[f.key] = input.checked;
        this.commit();
      };
      const span = document.createElement("span");
      span.textContent = f.label;
      label.append(input, span);
      return label;
    }

    if (f.kind === "select") {
      const sel = document.createElement("select");
      for (const o of f.options ?? []) {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.label;
        sel.appendChild(opt);
      }
      // 老模板可能缺字段（比如 valign），回落到第一项，避免下拉框空白
      sel.value = String(rec[f.key] ?? f.options?.[0]?.value ?? "");
      sel.onchange = () => {
        rec[f.key] = f.key === "rotate" ? Number(sel.value) : sel.value;
        this.commit();
      };
      return this.labelWrap(f.label, sel);
    }

    if (f.kind === "range") {
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(f.min ?? 0);
      input.max = String(f.max ?? 255);
      input.step = String(f.step ?? 1);
      input.value = String(rec[f.key]);
      const val = document.createElement("i");
      val.textContent = String(rec[f.key]);
      input.oninput = () => {
        rec[f.key] = Number(input.value);
        val.textContent = input.value;
        this.commit();
      };
      const wrap = this.labelWrap(f.label, input);
      wrap.appendChild(val);
      return wrap;
    }

    if (f.kind === "area") {
      const ta = document.createElement("textarea");
      ta.rows = 2;
      ta.value = String(rec[f.key] ?? "");
      ta.oninput = () => {
        rec[f.key] = ta.value;
        this.commit();
      };
      const label = document.createElement("label");
      label.className = "field field-block";
      const span = document.createElement("span");
      span.textContent = f.label;
      label.append(span, ta);
      return label;
    }

    if (f.kind === "text") {
      const input = document.createElement("input");
      input.type = "text";
      input.value = String(rec[f.key] ?? "");
      input.oninput = () => {
        rec[f.key] = input.value;
        this.commit();
      };
      return this.labelWrap(f.label, input);
    }

    /* 宽和中心 X 是耦合的：改宽要守住中心，改中心要带着宽度平移。
     * 通用 num 分支只会往字段里写数值，这两个键单独处理。 */
    if (f.kind === "num" && (f.key === "w" || f.key === "cx")) {
      const box = containerOf(this.doc.paper);
      const isCx = f.key === "cx";
      const input = this.numInput(
        isCx ? centerOf(el) : el.w,
        0.1,
        isCx ? 0 : MIN_WIDTH_MM,
        box,
        1,
        (v) => {
          const res = isCx
            ? placeByCenter(el, { centerMm: v, containerMm: box })
            : resizeKeepCenter(el, Math.min(box, Math.max(MIN_WIDTH_MM, v)), {
                containerMm: box,
              });
          if (res.shifted) {
            this.hooks.notify?.(
              `到纸边了：中心 X 从 ${res.requestedCenterX} 收到 ${res.centerX}mm`
            );
          }
          this.commit();
        }
      );
      return this.labelWrap(isCx ? "中心 X" : f.label, input, f.unit);
    }

    // num
    const input = this.numInput(
      Number(rec[f.key] ?? 0),
      f.step ?? 1,
      f.min ?? -999,
      f.max ?? 999,
      f.step && f.step < 1 ? 1 : 0,
      (v) => {
        rec[f.key] = v;
        this.commit();
      }
    );
    return this.labelWrap(f.label, input, f.unit);
  }

  /* ------------------------------------------------------------ 图片 */

  async pickImageFor(el: ImageElement) {
    try {
      const dataUrl = await this.hooks.pickImage?.();
      if (!dataUrl) return;
      el.dataUrl = dataUrl;
      this.cache.image.delete(dataUrl);
      this.commit();
      this.hooks.notify?.("图片已载入");
    } catch (e) {
      this.hooks.notify?.(`载入图片失败：${(e as Error).message}`, true);
    }
  }
}

/** 供外部构造空白文档用：保持与编辑器一致的类型收窄 */
export function ensureElement<T extends LabelElement>(el: T): T {
  return el;
}

export type {
  BarcodeElement,
  ImageElement,
  LineElement,
  QrCodeElement,
  RectElement,
  TextElement,
};
