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
import { isCompactLayout } from "./breakpoints";
import {
  centerInContainer,
  centerOf,
  containerOf,
  MIN_WIDTH_MM,
  placeByCenter,
  resizeKeepCenter,
} from "../core/align";
import { labelWrap, numInput } from "./form-controls";
import { COMMON, FIELDS, TYPE_LABEL, type FieldDef } from "./panel-fields";
import { PaperPanel, type PrintAccess } from "./paper-panel";
import { bindBoxDrag, bindGripDrag, type DragHost } from "./drag";
import {
  canvasSizeOf,
  createCache,
  forgetImage,
  printableMmOf,
  renderLabel,
  type RenderCache,
} from "../render/render-label";

/* ------------------------------------------------------------------ 编辑器 */

export interface EditorHooks {
  /** 文档变化（含拖拽、改属性、增删元素） */
  onChange?: (doc: LabelDoc) => void;
  /** 需要用户从磁盘选一张图 */
  pickImage?: () => Promise<string | null>;
  /** 状态栏文字 */
  notify?: (msg: string, isError?: boolean) => void;
}

/** 多选批量对齐/分布的方向 */
type AlignMode =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "centerX"
  | "centerY"
  | "spaceX"
  | "spaceY";

/**
 * 打印参数读写口。
 * 手机上工具栏被底部操作条取代，浓度和标签类型只能在「设置」里改，
 * 所以属性面板需要直接读写这两个控件（桌面端这两行不出现，避免和工具栏重复）。
 */
export type { PrintAccess };

export class LabelEditor {
  private doc: LabelDoc;
  private cache: RenderCache = createCache();
  private zoom = 1;
  /** 多选：选中的元素 id 列表，第一个是"主选中"（属性面板按它显示） */
  private selectedIds: string[] = [];
  /** 面板何时需要重建：只在选中变化/结构变化时重建，拖动时重建会打断输入焦点 */
  private panelDirty = true;
  /** 渲染队列：正在画的时候再来的改动只做标记，画完补一轮，避免并发抢 canvas */
  private rendering = false;
  private needRender = true;
  private canvas: HTMLCanvasElement;
  private overlay: HTMLElement;
  private inspector: HTMLElement;
  private hooks: EditorHooks;
  /** 纸张设置区。改纸时只回写数字，不重建面板（否则输入框焦点丢失） */
  private paperPanel: PaperPanel | null = null;
  /** 开始编辑纸张数字那一刻的纸型，失焦时用它算缩放比 */
  private paperEditBase: { w: number; h: number } | null = null;
  /** 就地编辑文字的收尾回调；有值就表示画布上正开着一个编辑框 */
  private inlineEditorClose: (() => void) | null = null;
  /** 正在就地编辑的元素 id，用来挡掉"同一次双击进来两遍" */
  private inlineEditingId: string | null = null;
  /** 浓度/标签类型的读写口（窄屏重排后面板里要用） */
  private print: PrintAccess | null;

  constructor(opts: {
    canvas: HTMLCanvasElement;
    overlay: HTMLElement;
    inspector: HTMLElement;
    doc: LabelDoc;
    print?: PrintAccess;
    hooks?: EditorHooks;
  }) {
    this.canvas = opts.canvas;
    this.overlay = opts.overlay;
    this.inspector = opts.inspector;
    this.doc = opts.doc;
    this.print = opts.print ?? null;
    this.hooks = opts.hooks ?? {};

    // 点空白处取消选中
    this.overlay.addEventListener("pointerdown", (e) => {
      if (e.target === this.overlay) this.select(null);
    });

    /* 点到别处就把就地编辑框收掉。
     * 元素框的 pointerdown 会 stopPropagation，所以只能挂在 window 的捕获阶段；
     * 也不能指望 blur：有些 WebView/自动化环境里 focus() 之后不派发 blur，
     * 编辑框会一直挂在画布上。 */
    window.addEventListener(
      "pointerdown",
      (e) => {
        const t = e.target as HTMLElement | null;
        if (this.inlineEditorClose && !t?.classList?.contains("inline-editor")) {
          this.inlineEditorClose();
        }
      },
      true
    );

    // Delete / Backspace 删除，方向键微调（多选时整体一起动）
    window.addEventListener("keydown", (e) => {
      const els = this.selectedElements();
      if (!els.length) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        this.removeSelected();
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
        for (const el of els) {
          el.x = round1(el.x + mv[0]);
          el.y = round1(el.y + mv[1]);
          this.clampToPaper(el);
        }
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
    this.selectedIds = [];
    this.cache = createCache();
    this.commit(true);
  }

  setZoom(z: number) {
    // 下限 0.2：手机竖屏上"整张标签塞进屏幕"可能比 0.4 还小
    this.zoom = Math.min(3, Math.max(0.2, z));
    this.commit();
  }

  /** 外部改了面板要读的选项（比如连上打印机后重建了标签类型）时调用 */
  refreshPanel() {
    this.commit(true);
  }

  getZoom(): number {
    return this.zoom;
  }

  get ppm(): number {
    return dotsPerMm(this.doc.paper.dpi) * this.zoom;
  }

  /** 主选中元素（多选时取第一个），属性面板按它渲染 */
  selected(): LabelElement | undefined {
    const id = this.selectedIds[0];
    return id ? this.doc.elements.find((e) => e.id === id) : undefined;
  }

  /** 当前全部选中元素，按文档顺序 */
  selectedElements(): LabelElement[] {
    const ids = new Set(this.selectedIds);
    return this.doc.elements.filter((e) => ids.has(e.id));
  }

  /**
   * 选中元素。
   * additive=true（按住 Shift/Ctrl 点击）是"加选/减选"，否则单选并清空原有选择。
   */
  select(id: string | null, additive = false) {
    if (!id) {
      this.selectedIds = [];
    } else if (additive) {
      this.selectedIds = this.selectedIds.includes(id)
        ? this.selectedIds.filter((x) => x !== id)
        : [...this.selectedIds, id];
    } else {
      this.selectedIds = [id];
    }
    this.commit(true);
  }

  /**
   * 手机预览的缩放：以"横向填满预览区"为基准再放大 1.4 倍。
   * 只按"整张塞进屏幕"算出来的比例太小（50×30 的标签只有约 0.85 倍），
   * 小字根本点不中；放大后超出预览卡片的部分由卡片内部滚动承担，
   * 页面本身仍然不滚。上限 2 倍，再大手柄和文字就蠢了。
   * 宽度取"画布宽"和"纸宽"的较大者：纸比打印头宽时右侧还有斜纹区。
   */
  fitToBox(pxW: number, pxH: number) {
    if (!(pxW > 0) || !(pxH > 0)) return;
    const { width, height } = canvasSizeOf(this.doc);
    const paperDots = this.doc.paper.widthMm * dotsPerMm(this.doc.paper.dpi);
    const naturalW = Math.max(width, paperDots);
    if (!naturalW || !height) return;
    // 横向填满 × 1.4；极端小屏（或超宽纸）算出来太小时退回"整页放下"
    const z = Math.min(
      2,
      Math.max(0.2, Math.max((pxW / naturalW) * 1.4, Math.min(pxW / naturalW, pxH / height))),
    );
    // 避免 0.001 级的抖动反复触发重绘
    if (Math.abs(z - this.zoom) < 0.01) return;
    this.setZoom(z);
  }

  /** 把元素的左上角夹回纸内：右下边界也要管，否则能拖到纸外去 */
  private clampToPaper(el: LabelElement) {
    const maxX = Math.max(0, containerOf(this.doc.paper) - el.w);
    const maxY = Math.max(0, this.doc.paper.heightMm - el.h);
    el.x = round1(Math.min(maxX, Math.max(0, el.x)));
    el.y = round1(Math.min(maxY, Math.max(0, el.y)));
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
    this.selectedIds = [el.id];
    this.commit(true);
    if (type === "image") void this.pickImageFor(el as ImageElement);
  }

  remove(id: string) {
    this.doc.elements = this.doc.elements.filter((e) => e.id !== id);
    this.selectedIds = this.selectedIds.filter((x) => x !== id);
    this.commit(true);
  }

  /** 删除所有选中的元素（多选时按一次 Delete 全清） */
  removeSelected() {
    const ids = new Set(this.selectedIds);
    if (!ids.size) return;
    this.doc.elements = this.doc.elements.filter((e) => !ids.has(e.id));
    this.selectedIds = [];
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
    this.selectedIds = [copy.id];
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
    this.paperPanel?.sync();
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
    this.paperPanel?.sync();
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
    } catch (err) {
      /* 单次渲染出错不能把整个 App 打穿：index.html 的兜底会把页面盖成全白
       * 的"启动失败"，用户既看不到画布也没法继续操作。这里收住，只提示一条，
       * 下一次交互再重画。 */
      const msg = err instanceof Error ? err.message : String(err);
      this.hooks.notify?.(`渲染失败：${msg}`, true);
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

    /* 预览按"屏幕像素"渲染：backing 尺寸 = 纸宽点数 × zoom × devicePixelRatio，
     * CSS 尺寸仍然是 × zoom。这样画布和屏幕像素基本 1:1，文字不再被拉伸发虚。
     * 打印路径不这么干，那边必须严格等于打印头点数。 */
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const previewScale = Math.min(4, Math.max(1, this.zoom * dpr));

    await renderLabel(this.canvas, this.doc, this.cache, { scale: previewScale });
    /* 预览画布的 backing 尺寸是放大过的，真实打印点数记在 dataset 上，
     * 测试和外部代码要判断"打出来多少点"应该读这里，而不是 canvas.width。 */
    this.canvas.dataset.printWidth = String(width);
    this.canvas.dataset.printHeight = String(height);
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
    const sel = new Set(this.selectedIds);

    /* 只清理"已经不存在的元素框"。
     * 遮罩层里还住着斜纹条（.dead-zone）和就地编辑框（.inline-editor），
     * 它们都没有 data-id。以前这里按"data-id 不在文档里"一律 remove()，
     * 会把正在编辑的 textarea 一并删掉；删它有几率触发 blur → finish() 再删一次，
     * 第二次 delete 抛 NotFoundError，整个渲染队列就烂掉（真机上表现为整屏"启动失败"）。
     * 所以先认 class 再比 id，真删也包一层 try：节点被别处（删除元素）先摘走时不再炸。 */
    for (const node of Array.from(this.overlay.children)) {
      const box = node as HTMLElement;
      if (!box.classList.contains("el-box")) continue;
      if (ids.has(box.dataset.id ?? "")) continue;
      try {
        this.overlay.removeChild(box);
      } catch {
        /* 已经被移除过了，忽略 */
      }
    }

    for (const el of this.doc.elements) {
      let box = this.overlay.querySelector<HTMLElement>(`[data-id="${el.id}"]`);
      if (!box) {
        box = document.createElement("div");
        box.className = "el-box";
        box.dataset.id = el.id;
        bindBoxDrag(box, el.id, this.dragHost());
        this.overlay.appendChild(box);
      }
      box.classList.toggle("selected", sel.has(el.id));
      box.classList.toggle("hidden-el", !el.visible);
      box.style.left = `${el.x * ppm}px`;
      box.style.top = `${el.y * ppm}px`;
      box.style.width = `${Math.max(6, el.w * ppm)}px`;
      box.style.height = `${Math.max(6, el.h * ppm)}px`;

      // 右下角缩放手柄：只在单选时给主选中元素插入，多选时不缩（避免歧义）
      let grip = box.querySelector<HTMLElement>(".grip");
      if (this.selectedIds.length === 1 && el.id === this.selectedIds[0]) {
        if (!grip) {
          grip = document.createElement("div");
          grip.className = "grip";
          bindGripDrag(grip, el.id, this.dragHost());
          box.appendChild(grip);
        }
      } else if (grip) {
        grip.remove();
      }
    }
  }

  /* ------------------------------------------------------------ 拖拽 */

  /** 把拖拽模块需要的状态/回调打包给它，模块自己不碰编辑器内部字段 */
  private dragHost(): DragHost {
    return {
      ppm: () => this.ppm,
      paper: () => this.doc.paper,
      find: (id) => this.doc.elements.find((e) => e.id === id),
      select: (id, additive) => this.select(id, additive),
      isSelected: (id) => this.selectedIds.includes(id),
      commit: () => this.commit(),
      clampToPaper: (el) => this.clampToPaper(el),
      /* 拖动"多选里的一个"时整组一起走，这是多选最常用的操作 */
      dragTargets: (id) => {
        const group = this.selectedIds.includes(id) ? this.selectedElements() : [];
        if (group.length > 1) return group;
        const one = this.doc.elements.find((e) => e.id === id);
        return one ? [one] : [];
      },
      onDoubleClick: (id) => this.activateElement(id),
    };
  }

  /** 双击元素：文字就地编辑，其它元素退回"跳到属性面板内容框" */
  private activateElement(id: string) {
    const el = this.doc.elements.find((e) => e.id === id);
    if (!el) return;
    if (el.type === "text" && el.rotate === 0) {
      /* 手机上双击常常既命中我们自己的"两次轻点"识别，又触发原生 dblclick，
       * 同一个元素会连着进来两次。第二次若把刚 focus 的 textarea 删掉重建，
       * 删除动作会同步触发 blur → finish() 再删一次 → NotFoundError，
       * 整个页面就被兜底成"启动失败"。已经在编辑这个元素就直接返回。 */
      if (this.inlineEditingId === el.id) return;
      this.startInlineEdit(el as TextElement);
      return;
    }
    // 旋转过的文字在画布上是斜的，就地编辑框对不上，仍然走属性面板
    this.focusContentField();
  }

  /**
   * 就地编辑文字：在元素位置盖一个 textarea，样式跟着元素的字号/对齐走。
   * 失焦或 Ctrl+Enter 写回文档，Esc 放弃。
   * 用 textarea 而不是 contentEditable：换行、粘贴、输入法都天然正确。
   */
  private startInlineEdit(el: TextElement) {
    /* 同时只允许一个编辑框。收旧的必须走 inlineEditorClose（内部会先置 done
     * 再摘节点），不能直接 .remove()：删一个正在 focus 的 textarea 会同步触发
     * blur → finish() → 再删一次，第二次就抛 NotFoundError。 */
    this.inlineEditorClose?.();
    this.inlineEditingId = el.id;

    const ppm = this.ppm;
    const ta = document.createElement("textarea");
    ta.className = "inline-editor";
    ta.value = el.text;
    ta.style.left = `${el.x * ppm}px`;
    ta.style.top = `${el.y * ppm}px`;
    ta.style.width = `${Math.max(20, el.w * ppm)}px`;
    ta.style.height = `${Math.max(14, el.h * ppm)}px`;
    ta.style.fontSize = `${Math.max(1, el.fontSizeMm * ppm)}px`;
    ta.style.fontWeight = el.bold ? "700" : "400";
    ta.style.textAlign = el.align;
    ta.style.lineHeight = String(el.lineHeight);

    let done = false;
    const original = el.text;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      // 输入时已经实时写回文档，取消编辑要把原值放回去
      el.text = save ? ta.value : original;
      this.inlineEditorClose = null;
      this.inlineEditingId = null;
      // 节点可能已经被别处摘走（删元素、切模板），再 remove 会抛 NotFoundError
      if (ta.parentNode) {
        try {
          ta.parentNode.removeChild(ta);
        } catch {
          /* ignore */
        }
      }
      this.commit(true);
    };
    // 让"点到别处"能找到这个编辑框
    this.inlineEditorClose = () => finish(true);

    /* 边打边写回文档：这样即使输入过程中焦点被系统抢走（没收到 blur），
     * 已经敲进去的字也不会丢。 */
    ta.addEventListener("input", () => {
      el.text = ta.value;
      this.commit();
    });
    ta.addEventListener("blur", () => finish(true));
    ta.addEventListener("keydown", (e) => {
      // 编辑时别让全局快捷键（方向键挪元素、Delete 删元素）抢走按键
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        finish(true);
      }
      // 普通 Enter 保留换行：标签上的多行文字就是这样敲出来的
    });

    this.overlay.appendChild(ta);
    ta.focus();
    ta.select();
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

  /* ------------------------------------------------------------ 属性面板 */

  /**
   * 手机单栏布局的断点。必须和 styles.css 里 @media (max-width: 860px) 保持一致，
   * 否则会出现"面板已经变抽屉、内容却还按桌面顺序排"的错位。
   */
  private isCompact(): boolean {
    return isCompactLayout();
  }

  private buildInspector() {
    const root = this.inspector;
    root.textContent = "";

    const els = this.selectedElements();

    /* 手机上属性面板是从底部弹出的，只占 62vh。纸张设置（纸型/宽/高/点数）
     * 一排下来就把"内容"输入框顶到看不见的地方了 —— 用户会以为得长按才能编辑。
     * 所以窄屏把元素区提到最前面，桌面保持"纸张在上"的原顺序。 */
    if (this.isCompact()) {
      if (els.length > 1) {
        root.appendChild(this.multiSection(els));
        root.appendChild(this.paperSection());
        return;
      }
      const one = els[0];
      if (one) {
        root.appendChild(this.elementSection(one));
        root.appendChild(this.paperSection());
        return;
      }
    }

    root.appendChild(this.paperSection());

    if (els.length > 1) {
      root.appendChild(this.multiSection(els));
      return;
    }

    const el = els[0];
    if (!el) {
      const tip = document.createElement("p");
      tip.className = "hint mt";
      tip.textContent =
        "点画布上的元素可以改属性；按住 Shift/Ctrl 点多个（手机直接点多个）可以批量对齐。";
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

    /* 手机上"长按加选"没有 Shift 键可以替代，不给提示就没人知道
     * 怎么才能选到 2 个元素 —— 对齐/等间距按钮只在多选时才出现。 */
    if (this.isCompact()) {
      const tip = document.createElement("p");
      tip.className = "hint mt";
      tip.textContent = "直接点另一个元素即可加选，点画布空白处取消全部；选中 2 个以上会出现批量对齐和等间距。";
      wrap.appendChild(tip);
    }

    if (el.type === "text") {
      const tip = document.createElement("p");
      tip.className = "hint mt";
      tip.textContent =
        "双击画布上的文字可直接改内容（手机连点两下）：Esc 取消，Ctrl+Enter 完成，Enter 换行。";
      wrap.appendChild(tip);
    }

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

  /**
   * 多选时的批量操作区：对齐。
   * 对齐基准是"选中元素的外接矩形"，跟常见设计工具一致：
   * 左对齐＝所有元素左边贴到最左那条边，而不是贴纸边。
   */
  private multiSection(els: LabelElement[]): HTMLElement {
    const wrap = document.createElement("div");

    const title = document.createElement("h2");
    title.className = "mt";
    title.textContent = `已选中 ${els.length} 个元素`;
    wrap.appendChild(title);

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent =
      "按住 Shift/Ctrl 点元素可以加选（手机上直接点下一个元素即可加选，点空白处取消）；拖动其中任意一个，整组一起移动。";
    wrap.appendChild(hint);

    const buttons: { label: string; mode: AlignMode }[] = [
      { label: "左对齐", mode: "left" },
      { label: "右对齐", mode: "right" },
      { label: "顶端对齐", mode: "top" },
      { label: "底端对齐", mode: "bottom" },
      { label: "水平居中", mode: "centerX" },
      { label: "垂直居中", mode: "centerY" },
      { label: "水平等间距", mode: "spaceX" },
      { label: "垂直等间距", mode: "spaceY" },
    ];

    const rows: HTMLElement[] = [];
    buttons.forEach((b, i) => {
      if (i % 2 === 0) {
        const row = document.createElement("div");
        row.className = "row-actions mt";
        rows.push(row);
      }
      const btn = document.createElement("button");
      btn.textContent = b.label;
      btn.onclick = () => this.alignSelection(b.mode, b.label);
      rows[rows.length - 1].appendChild(btn);
    });
    wrap.append(...rows);

    const actions = document.createElement("div");
    actions.className = "row-actions mt";
    const del = document.createElement("button");
    del.textContent = `删除所选（${els.length}）`;
    del.onclick = () => this.removeSelected();
    actions.appendChild(del);
    wrap.appendChild(actions);

    return wrap;
  }

  /** 把选中的多个元素按外接矩形对齐 / 等间距分布 */
  alignSelection(mode: AlignMode, label: string) {
    const els = this.selectedElements();
    if (els.length < 2) return;

    /* 等间距：首尾两个不动，中间按"剩余空隙平均分"摆。
     * 注意基准是**空隙**而不是元素中心——元素宽度不同时，
     * 按中心等距会让窄的挨得近、宽的离得远，看起来并不均匀。 */
    if (mode === "spaceX" || mode === "spaceY") {
      const horizontal = mode === "spaceX";
      const sorted = [...els].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const span = horizontal
        ? last.x + last.w - first.x
        : last.y + last.h - first.y;
      const sumSize = sorted.reduce((s, e) => s + (horizontal ? e.w : e.h), 0);
      const gap = (span - sumSize) / (sorted.length - 1);
      let cursor = horizontal ? first.x : first.y;
      for (const e of sorted) {
        if (horizontal) {
          e.x = round1(cursor);
          cursor += e.w + gap;
        } else {
          e.y = round1(cursor);
          cursor += e.h + gap;
        }
        this.clampToPaper(e);
      }
      this.commit();
      this.hooks.notify?.(`已${label}：${els.length} 个元素，间距 ${round1(Math.max(0, gap))}mm`);
      return;
    }

    const minX = Math.min(...els.map((e) => e.x));
    const maxR = Math.max(...els.map((e) => e.x + e.w));
    const minY = Math.min(...els.map((e) => e.y));
    const maxB = Math.max(...els.map((e) => e.y + e.h));

    for (const e of els) {
      switch (mode) {
        case "left":
          e.x = round1(Math.max(0, minX));
          break;
        case "right":
          e.x = round1(maxR - e.w);
          break;
        case "top":
          e.y = round1(Math.max(0, minY));
          break;
        case "bottom":
          e.y = round1(maxB - e.h);
          break;
        case "centerX":
          e.x = round1((minX + maxR) / 2 - e.w / 2);
          break;
        case "centerY":
          e.y = round1((minY + maxB) / 2 - e.h / 2);
          break;
      }
      // 对齐后可能贴到纸外，统一夹回纸内
      this.clampToPaper(e);
    }
    this.commit();
    this.hooks.notify?.(`已${label}：${els.length} 个元素`);
  }

  /** 纸张设置：不选中元素时也能改，随时可用。具体控件在 paper-panel.ts */
  private paperSection(): HTMLElement {
    this.paperPanel = new PaperPanel({
      paper: () => this.doc.paper,
      setPaperSize: (patch) => this.setPaperSize(patch),
      setPaperSizeScaled: (w, h) => this.setPaperSizeScaled(w, h),
      beginPaperEdit: () => {
        this.paperEditBase = { w: this.doc.paper.widthMm, h: this.doc.paper.heightMm };
      },
      applyPaperEdit: () => this.applyPaperEdit(),
      maxWidthMm: () => this.maxWidthMm(),
      printableWidthMm: () => this.printableWidthMm(),
      zoom: () => this.zoom,
      setZoom: (z) => this.setZoom(z),
      notify: (msg, err) => this.hooks.notify?.(msg, err),
      print: this.print ?? undefined,
    });
    return this.paperPanel.root;
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
      return labelWrap(f.label, sel);
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
      const wrap = labelWrap(f.label, input);
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
      return labelWrap(f.label, input);
    }

    /* 宽和中心 X 是耦合的：改宽要守住中心，改中心要带着宽度平移。
     * 通用 num 分支只会往字段里写数值，这两个键单独处理。 */
    if (f.kind === "num" && (f.key === "w" || f.key === "cx")) {
      const box = containerOf(this.doc.paper);
      const isCx = f.key === "cx";
      const input = numInput(
        isCx ? centerOf(el) : el.w,
        0.1,
        isCx ? 0 : MIN_WIDTH_MM,
        box,
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
      return labelWrap(isCx ? "中心 X" : f.label, input, f.unit);
    }

    // num
    const input = numInput(
      Number(rec[f.key] ?? 0),
      f.step ?? 1,
      f.min ?? -999,
      f.max ?? 999,
      (v) => {
        rec[f.key] = v;
        this.commit();
      }
    );
    return labelWrap(f.label, input, f.unit);
  }

  /* ------------------------------------------------------------ 图片 */

  async pickImageFor(el: ImageElement) {
    try {
      const dataUrl = await this.hooks.pickImage?.();
      if (!dataUrl) return;
      el.dataUrl = dataUrl;
      forgetImage(this.cache, dataUrl);
      this.commit();
      this.hooks.notify?.("图片已载入");
    } catch (e) {
      this.hooks.notify?.(`载入图片失败：${(e as Error).message}`, true);
    }
  }
}

export type {
  BarcodeElement,
  ImageElement,
  LineElement,
  QrCodeElement,
  RectElement,
  TextElement,
};
