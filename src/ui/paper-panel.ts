/**
 * 纸张设置区
 * ------------------------------------------------------------------
 * 纸型预设、宽/高、打印头点数、以及显示缩放。独立成一个类，
 * 编辑器只负责把"改纸"这件事往外抛，面板自己维护输入框。
 *
 * 只在面板重建时新建实例；改纸时走 sync() 回写数字，
 * 不重建 DOM——否则正在输入的框会被换掉，焦点丢失（"设不了 50"就出在这）。
 */
import { canvasSizeOf } from "../render/render-label";
import { labelWrap } from "./form-controls";
import { PAPER_PRESETS } from "./panel-fields";
import { isCompactLayout } from "./breakpoints";
import type { PaperSetup } from "../core/label-doc";

/**
 * 打印参数读写口：浓度、标签类型。
 * 桌面上这两项在工具栏里；手机上工具栏换成了底部操作条，
 * 想改只能从这里改，所以窄屏时纸张区末尾会多出这两行。
 */
export interface PrintAccess {
  density(): { value: number; min: number; max: number };
  setDensity(v: number): void;
  labelType(): { value: number; disabled: boolean; options: { value: number; label: string }[] };
  setLabelType(v: number): void;
}

export interface PaperPanelHooks {
  paper(): PaperSetup;
  /** 只改纸张尺寸，不缩放内容 */
  setPaperSize(patch: Partial<PaperSetup>): void;
  /** 换纸型：改尺寸并把整版内容等比缩放 */
  setPaperSizeScaled(w: number, h: number): void;
  /** 宽/高输入框获得焦点：记下这次编辑开始时的纸型 */
  beginPaperEdit(): void;
  /** 宽/高输入框失焦：按新纸型缩放一次版式 */
  applyPaperEdit(): void;
  maxWidthMm(): number;
  printableWidthMm(): number;
  zoom(): number;
  setZoom(z: number): void;
  notify(msg: string, isError?: boolean): void;
  /** 浓度/标签类型的读写口（窄屏才用） */
  print?: PrintAccess;
}

interface PaperInputs {
  w: HTMLInputElement;
  h: HTMLInputElement;
  info: HTMLElement;
  limit: HTMLElement;
  preset: HTMLSelectElement;
}

export class PaperPanel {
  readonly root: HTMLElement;
  private inputs: PaperInputs;
  /** 是否正在编辑宽/高（用来只在第一次 input 时记录基准纸型） */
  private editing = false;

  constructor(private hooks: PaperPanelHooks) {
    this.root = document.createElement("div");
    // 用类名统一控制行间距，避免"纸型"和"宽/高"两行贴在一起
    this.root.className = "paper-panel";
    this.inputs = this.build();
    this.sync();
  }

  private build(): PaperInputs {
    const wrap = this.root;

    const h = document.createElement("h2");
    h.textContent = "纸张";
    wrap.appendChild(h);

    const preset = document.createElement("select");
    for (const p of PAPER_PRESETS) {
      const o = document.createElement("option");
      o.value = `${p.w}x${p.h}`;
      o.textContent = p.label;
      preset.appendChild(o);
    }
    preset.onchange = () => {
      const [w, h2] = preset.value.split("x").map(Number);
      if (w > 0 && h2 > 0) this.hooks.setPaperSizeScaled(w, h2);
      else {
        const p = this.hooks.paper();
        preset.value = `${p.widthMm}x${p.heightMm}`;
      }
    };
    wrap.appendChild(labelWrap("纸型", preset));

    const wInput = this.dimInput("w");
    const hInput = this.dimInput("h");

    const row = document.createElement("div");
    row.className = "row paper-row";
    row.append(labelWrap("宽", wInput, "mm"), labelWrap("高", hInput, "mm"));
    wrap.appendChild(row);

    /* 打印头点数不再暴露给用户：B1 实测就是 400 点（50mm），
     * 选 384 只会让右边少 2mm 白白浪费，这个开关除了让人困惑没别的作用。
     * 老模板里存了 384 的仍然尊重它，只是 UI 上不再提供切换。 */

    const info = document.createElement("p");
    info.className = "size-line";
    wrap.appendChild(info);

    const limit = document.createElement("p");
    limit.className = "hint";
    wrap.appendChild(limit);

    // 缩放只是显示比例，不改变打印内容，所以放在纸张区块最后
    const zoom = document.createElement("input");
    zoom.type = "range";
    zoom.min = "0.4";
    zoom.max = "2.5";
    zoom.step = "0.1";
    zoom.value = String(this.hooks.zoom());
    const zval = document.createElement("i");
    zval.textContent = `${Math.round(this.hooks.zoom() * 100)}%`;
    zoom.oninput = () => {
      this.hooks.setZoom(Number(zoom.value));
      zval.textContent = `${Math.round(this.hooks.zoom() * 100)}%`;
    };
    wrap.appendChild(labelWrap("缩放", zoom)).appendChild(zval);

    // 窄屏没有工具栏了，浓度和标签类型跟在纸张设置后面
    if (isCompactLayout() && this.hooks.print) this.buildPrintRows(this.hooks.print);

    return { w: wInput, h: hInput, info, limit, preset };
  }

  /** 浓度 + 标签类型（只在窄屏出现，避免和桌面工具栏重复） */
  private buildPrintRows(print: PrintAccess): void {
    const wrap = this.root;

    const h = document.createElement("h2");
    h.className = "mt";
    h.textContent = "打印";
    wrap.appendChild(h);

    const lt = print.labelType();
    const sel = document.createElement("select");
    for (const o of lt.options) {
      const opt = document.createElement("option");
      opt.value = String(o.value);
      opt.textContent = o.label;
      sel.appendChild(opt);
    }
    sel.value = String(lt.value);
    // 没连打印机时和工具栏一样不可选：机型支持哪些纸要连上才知道
    sel.disabled = lt.disabled;
    sel.onchange = () => print.setLabelType(Number(sel.value));
    wrap.appendChild(labelWrap("标签类型", sel));

    const d = print.density();
    const range = document.createElement("input");
    range.type = "range";
    range.min = String(d.min);
    range.max = String(d.max);
    range.step = "1";
    range.value = String(d.value);
    const val = document.createElement("i");
    val.textContent = String(d.value);
    range.oninput = () => {
      print.setDensity(Number(range.value));
      val.textContent = range.value;
    };
    wrap.appendChild(labelWrap("浓度", range)).appendChild(val);
  }

  /**
   * 纸张宽/高输入框。
   * 两个时机分开处理，缺一不可：
   *   input  实时改纸（画布马上变宽变窄，手感直观），但**不**缩放内容；
   *   change 失焦/回车时才按比例缩放整版内容。
   * 如果 input 就缩放，输"50"会先按"5"缩一次再按"50"缩一次，版式被越缩越小。
   */
  private dimInput(kind: "w" | "h"): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "number";
    input.step = "1";
    input.min = "5";
    input.max = kind === "w" ? "200" : "300";
    input.value = String(kind === "w" ? this.hooks.paper().widthMm : this.hooks.paper().heightMm);

    // 记住编辑开始时的纸型：失焦时用它算缩放比，否则会拿已经改过的值当基准
    input.addEventListener("focus", () => this.hooks.beginPaperEdit());

    input.addEventListener("input", () => {
      const v = Number(input.value);
      if (!Number.isFinite(v) || v < 5) return;
      /* 兜底记录基准纸型：正常流程靠 focus 事件，但合成事件（自动化测试）
       * 或某些浏览器不派发 focus 时 base 会是空的，失焦就缩不了。
       * 只在这次编辑的第一次 input 记一次，避免每敲一位就把基准重置成当前值。 */
      if (!this.editing) {
        this.hooks.beginPaperEdit();
        this.editing = true;
      }
      if (kind === "w") {
        this.hooks.setPaperSize({ widthMm: v });
        const head = this.hooks.maxWidthMm();
        // 设得比打印头宽不拦，只提示：直接拒绝，用户会以为程序坏了
        if (v > head + 0.05) {
          this.hooks.notify(
            `纸宽 ${v}mm，当前可打印只有 ${head}mm：右侧 ${(v - head).toFixed(1)}mm 打不到（预览里已标斜纹）`
          );
        }
      } else {
        this.hooks.setPaperSize({ heightMm: v });
      }
    });

    input.addEventListener("change", () => {
      this.editing = false;
      this.hooks.applyPaperEdit();
      // 失焦时把输入框纠正成真实生效值（比如被夹到下限）
      const p = this.hooks.paper();
      input.value = String(kind === "w" ? p.widthMm : p.heightMm);
    });

    return input;
  }

  /** 改纸后回写数字与提示，不碰 DOM 结构，避免正在输入的框被换掉 */
  sync(): void {
    const p = this.inputs;
    const paper = this.hooks.paper();
    // 正在输入的框不要硬改，否则光标会跳；失焦时由 change 事件纠正
    if (document.activeElement !== p.w) p.w.value = String(paper.widthMm);
    if (document.activeElement !== p.h) p.h.value = String(paper.heightMm);
    /* 预设下拉跟着当前尺寸走：尺寸对得上就选中对应项，对不上就落到"自定义"。
     * 不这么做的话，文件里存的是 50×30，下拉却永远显示"自定义"，看着像没生效。 */
    if (document.activeElement !== p.preset) {
      const key = `${paper.widthMm}x${paper.heightMm}`;
      p.preset.value = Array.from(p.preset.options).some((o) => o.value === key) ? key : "0x0";
    }
    const { width, height } = canvasSizeOf({ paper });
    const realW = this.hooks.printableWidthMm();
    // 直接显示"50×30"这种尺寸，代替原来那个没人看得懂的打印头点数
    p.info.textContent = `${paper.widthMm}×${paper.heightMm} mm`;
    p.limit.textContent =
      paper.widthMm > realW + 0.05
        ? `${width}×${height} 点 · 右侧 ${(paper.widthMm - realW).toFixed(1)}mm 打不到（预览里已标斜纹）`
        : `${width}×${height} 点 @${paper.dpi}dpi，本页宽度用满`;
  }
}
