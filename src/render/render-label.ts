/**
 * 标签渲染：把 LabelDoc 画到 canvas 上
 * ------------------------------------------------------------------
 * 三条硬规矩，都是为了"打出来能扫"：
 *
 * 1. 一维码不能随便缩放。条宽必须是**整数像素**，否则打印机二值化后
 *    模块宽窄不一，扫码枪就废了。所以先按 1 像素/模块算出自然宽度，
 *    再取整数倍的模块宽度重新生成，超出的部分留白，不做拉伸。
 *
 * 2. 图片要先二值化再交给打印机。库里虽然也会按亮度判断，
 *    但照片类图片不做抖动会糊成一片黑，所以这里自己做阈值/抖动。
 *
 * 3. 全部按 mm 排版，最后一步才换算成点。这样 203dpi 和 300dpi
 *    的机器用同一份模板，位置不会跑。
 *
 * 4. 画完必须"落墨"：整张图按亮度判成纯黑/纯白，不留抗锯齿灰边。
 *    原因见 INK_THRESHOLD 的注释——这一条直接决定粗体字打出来是清晰还是发虚。
 */
import JsBarcode from "jsbarcode";
import QRCode from "qrcode";
import type {
  BarcodeElement,
  ImageElement,
  LabelDoc,
  LabelElement,
  PaperSetup,
  QrCodeElement,
  TextElement,
} from "../core/label-doc";
import { dotsPerMm, mmToDots } from "../core/units";

/** 渲染上下文里带缓存，避免每帧重新生成条码图片 */
export interface RenderCache {
  barcode: Map<string, HTMLCanvasElement>;
  qrcode: Map<string, HTMLCanvasElement>;
  image: Map<string, HTMLImageElement>;
  /* 文字位图缓存。拖拽元素时只有坐标在变、文字本身没变，
   * 缓存命中后一帧只要一次 drawImage，40ms 的超采样开销全省下来。 */
  text: Map<string, HTMLCanvasElement>;
}

export function createCache(): RenderCache {
  return { barcode: new Map(), qrcode: new Map(), image: new Map(), text: new Map() };
}

/** 缓存别无限涨：改一次字就多一份 */
function remember(map: Map<string, HTMLCanvasElement>, key: string, cv: HTMLCanvasElement) {
  map.set(key, cv);
  if (map.size > 64) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
}

/** 整张标签的像素尺寸，打印和预览共用 */
export function canvasSizeOf(doc: LabelDoc) {
  return {
    width: printableDotsOf(doc.paper),
    height: mmToDots(doc.paper.heightMm, doc.paper.dpi),
  };
}

/**
 * 这一页真正要发给打印机的宽度（点）= 纸宽（点），但不超过打印头点数。
 * ------------------------------------------------------------------
 * 之前这里直接返回打印头点数，于是"纸宽 48"和"纸宽 50"发出去的都是
 * 400 点（50mm）的位图——参数不同、结果一模一样，纸宽设了等于没设。
 * 现在按纸宽算：48mm→384 点、50mm→400 点，页宽会随页尺寸包一起下发，
 * 打印机按这个宽度出图，改纸宽才会真的改打印结果。
 */
export function printableDotsOf(paper: PaperSetup): number {
  const want = mmToDots(paper.widthMm, paper.dpi);
  return Math.max(1, Math.min(paper.printheadDots, want));
}

/** 这一页能打多宽（mm），死区提示和排版都用它 */
export function printableMmOf(paper: PaperSetup): number {
  return (printableDotsOf(paper) * 25.4) / paper.dpi;
}

/** 主入口：画布尺寸由文档决定，调用前不要手动设 canvas.width */
export async function renderLabel(
  canvas: HTMLCanvasElement,
  doc: LabelDoc,
  cache: RenderCache = createCache()
): Promise<void> {
  const { width, height } = canvasSizeOf(doc);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;

  const g = canvas.getContext("2d");
  if (!g) return;

  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = "#fff";
  g.fillRect(0, 0, width, height);
  g.restore();

  const ppm = dotsPerMm(doc.paper.dpi);
  for (const el of doc.elements) {
    if (!el.visible) continue;
    await drawElement(g, el, ppm, cache);
  }

  // 最后一步统一"落墨"，把抗锯齿的灰边收干净（见 INK_THRESHOLD）
  binarize(canvas, INK_THRESHOLD);
}

/* ------------------------------------------------------------------ 落墨 */

/**
 * 收尾的统一"落墨"：整张图按亮度判成纯黑/纯白。
 * ------------------------------------------------------------------
 * 为什么这一步不能交给库：
 * niimbluelib 的编码器只认"纯白 0xffffff"，其余**一切**颜色都当黑点。
 * canvas 的弧线、旋转过的位图、图片缩放都会留下深浅不一的灰边，
 * 这些灰边被一律当成黑，等于给每个形状描了一圈边——粗体就是这么糊掉的。
 *
 * 文字更狠的坑在别处（小字会被砍断笔画），所以文字单独走
 * TEXT_SS 超采样 + 覆盖率降采样（见 drawText），到这一步已经是纯黑白，
 * 这里只负责把剩下的图形元素收干净。取 150 而不是 128，
 * 是为了稍微偏向"留墨"——热敏纸欠烧时会掉笔画。
 */
export const INK_THRESHOLD = 150;


/** 就地把画布二值化成纯黑白（预览和打印共用同一份结果，所见即所打） */
export function binarize(canvas: HTMLCanvasElement, threshold = INK_THRESHOLD): void {
  const w = canvas.width;
  const h = canvas.height;
  if (w <= 0 || h <= 0) return;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  if (!g) return;

  const img = g.getImageData(0, 0, w, h);
  const px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    const v = lum < threshold ? 0 : 255;
    px[i] = v;
    px[i + 1] = v;
    px[i + 2] = v;
    px[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}


async function drawElement(
  g: CanvasRenderingContext2D,
  el: LabelElement,
  ppm: number,
  cache: RenderCache
) {
  const x = el.x * ppm;
  const y = el.y * ppm;
  const w = el.w * ppm;
  const h = el.h * ppm;

  g.save();
  if (el.rotate !== 0) {
    // 绕元素中心旋转，转完把坐标系挪回去，下面的代码仍然按左上角画
    g.translate(x + w / 2, y + h / 2);
    g.rotate((el.rotate * Math.PI) / 180);
    g.translate(-w / 2, -h / 2);
  } else {
    g.translate(x, y);
  }

  /* 一律裁到元素外框内。
   * 条码的明文、超长的文字都可能比框大，不裁的话会压到别的元素上，
   * 而打印机上看到的就是"莫名其妙多出来一截黑"。裁掉＝所见即所得。 */
  g.beginPath();
  g.rect(0, 0, w, h);
  g.clip();

  switch (el.type) {
    case "text":
      drawText(g, el, ppm, w, h, cache);
      break;
    case "rect": {
      // 整数像素 + 四条实心边，不用 strokeRect：描边会带抗锯齿，点阵边上全是灰
      const W = Math.round(w);
      const H = Math.round(h);
      g.fillStyle = "#000";
      if (el.filled) {
        g.fillRect(0, 0, W, H);
      } else {
        const lw = Math.max(1, Math.round(el.strokeMm * ppm));
        g.fillRect(0, 0, W, lw);
        g.fillRect(0, H - lw, W, lw);
        g.fillRect(0, 0, lw, H);
        g.fillRect(W - lw, 0, lw, H);
      }
      break;
    }
    case "line": {
      g.fillStyle = "#000";
      const W = Math.round(w);
      const H = Math.round(h);
      const t = Math.max(1, Math.round(el.thicknessMm * ppm));
      // 用矩形画线，不走 stroke，避免端点圆角影响点阵精度
      if (W >= H) {
        g.fillRect(0, Math.max(0, Math.round((H - t) / 2)), W, t);
      } else {
        g.fillRect(Math.max(0, Math.round((W - t) / 2)), 0, t, H);
      }
      break;
    }
    case "barcode":
      drawBarcode(g, el, ppm, w, h, cache);
      break;
    case "qrcode":
      await drawQr(g, el, w, h, cache);
      break;
    case "image":
      await drawImage(g, el, w, h, cache);
      break;
  }

  g.restore();
}

/* ------------------------------------------------------------------ 文字 */

/**
 * 文字超采样倍数。
 * ------------------------------------------------------------------
 * 1 位打印机只有"打/不打"两档，而 canvas 画字必然带抗锯齿。
 * 直接把抗锯齿结果卡阈值（灰度 < 150 算墨）在 2mm 以上的字上没问题，
 * 但 1.4~1.8mm 的注释字只有 11~14 个像素高，笔画边缘一半是灰，
 * 阈值一卡就断笔、缺肉，看着比原来还脏。
 *
 * 解法是按 3 倍把字画大，再按"覆盖率"降到 1 倍：
 * 每个输出点 = 9 个样本里有多少被笔画盖住，超过 40% 就打墨。
 * 这等价于把字形轮廓重新栅格化一遍，小字也能保住笔画。
 */
const TEXT_SS = 3;
/** 降采样判定：覆盖率 > 这个比例就算墨。0.4 略偏"留墨"，抵消热敏纸欠烧 */
const INK_COVERAGE = 0.5;

function fontOf(el: TextElement, ppm: number): string {
  const px = Math.max(1, el.fontSizeMm * ppm);
  return `${el.bold ? "bold " : ""}${px}px "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif`;
}

/** 文字位图的缓存键：所有影响"长什么样"的字段都在里面，坐标不在（坐标只影响贴的位置） */
function textKey(el: TextElement, ppm: number, w: number, h: number): string {
  return [
    el.text,
    el.fontSizeMm,
    Math.round(ppm * 100), // 换 dpi 时字号的实际像素会变，必须进键
    el.bold ? 1 : 0,
    el.align,
    el.valign ?? "middle",
    el.lineHeight,
    el.wrap ? 1 : 0,
    Math.round(w),
    Math.round(h),
  ].join("|");
}

/** 把文字先画在 3 倍大的临时画布上，再按覆盖率降到目标尺寸贴回去 */
function drawText(
  g: CanvasRenderingContext2D,
  el: TextElement,
  ppm: number,
  w: number,
  h: number,
  cache: RenderCache
) {
  const key = textKey(el, ppm, w, h);
  let bmp = cache.text.get(key);

  if (!bmp) {
    const s = TEXT_SS;
    const tmp = document.createElement("canvas");
    tmp.width = Math.max(1, Math.ceil(w * s));
    tmp.height = Math.max(1, Math.ceil(h * s));
    const t = tmp.getContext("2d", { willReadFrequently: true });
    if (!t) return;

    t.fillStyle = "#fff";
    t.fillRect(0, 0, tmp.width, tmp.height);
    paintText(t, el, ppm * s, tmp.width, tmp.height);

    bmp = coverageDownsample(tmp, s, INK_COVERAGE);
    remember(cache.text, key, bmp);
  }

  g.drawImage(bmp, 0, 0);
}

/** 覆盖率降采样：s×s 个样本的平均亮度低于阈值就落墨 */
function coverageDownsample(src: HTMLCanvasElement, s: number, coverage: number): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = Math.ceil(src.width / s);
  out.height = Math.ceil(src.height / s);
  const og = out.getContext("2d");
  const sg = src.getContext("2d", { willReadFrequently: true });
  if (!og || !sg) return src;

  const srcData = sg.getImageData(0, 0, src.width, src.height).data;
  const img = og.createImageData(out.width, out.height);
  const dst = img.data;
  const limit = (1 - coverage) * 255; // 覆盖率越高 → 平均亮度越低 → 越容易落墨

  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = 0; dy < s; dy++) {
        const sy = y * s + dy;
        if (sy >= src.height) break;
        for (let dx = 0; dx < s; dx++) {
          const sx = x * s + dx;
          if (sx >= src.width) break;
          const i = (sy * src.width + sx) * 4;
          sum += 0.299 * srcData[i] + 0.587 * srcData[i + 1] + 0.114 * srcData[i + 2];
          n++;
        }
      }
      const v = n > 0 && sum / n < limit ? 0 : 255;
      const o = (y * out.width + x) * 4;
      dst[o] = v;
      dst[o + 1] = v;
      dst[o + 2] = v;
      dst[o + 3] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  return out;
}

/** 真正的绘制：坐标已经是超采样后的像素 */

function paintText(
  g: CanvasRenderingContext2D,
  el: TextElement,
  ppm: number,
  w: number,
  h: number
) {
  g.fillStyle = "#000";
  g.font = fontOf(el, ppm);

  /* 用 middle 基线，每一行按"行中心"定位。
   * 之前的 top 基线是文字"顶边"，字身内部还有一段 ascent 留白，
   * 所以看上去总是偏上；改成 center 定位后框和字的几何中心才真正重合。 */
  g.textBaseline = "middle";
  g.textAlign = el.align === "center" ? "center" : el.align === "right" ? "right" : "left";

  const lineH = el.fontSizeMm * ppm * el.lineHeight;
  const lines: string[] = [];

  for (const raw of el.text.split("\n")) {
    if (!el.wrap) {
      lines.push(raw);
      continue;
    }
    /* 折行：中文没有空格，只能逐字累加试探；但数字/英文串不能拆，
     * 否则 "502" 会被切成 "5" 和 "02" 两行，读起来像另一个数。
     * 所以先把连续的英数字符包成一个整体（token），再按 token 累加。 */
    const isWordChar = (c: string) => /[0-9A-Za-z.+\-×*#/]/.test(c);
    const tokens: string[] = [];
    let buf = "";
    for (const ch of raw) {
      if (isWordChar(ch)) {
        buf += ch;
      } else {
        if (buf) {
          tokens.push(buf);
          buf = "";
        }
        tokens.push(ch);
      }
    }
    if (buf) tokens.push(buf);

    let cur = "";
    const pushLine = () => {
      lines.push(cur.replace(/\s+$/, ""));
      cur = "";
    };
    for (const tk of tokens) {
      const test = cur + tk;
      if (g.measureText(test).width > w && cur !== "") {
        pushLine();
      }
      // 行首的空格没意义，丢掉
      const piece = cur === "" ? tk.replace(/^\s+/, "") : tk;
      if (piece === "") continue;
      // token 本身比整行还宽（超长英文串）时，只能按字符硬拆
      if (cur === "" && g.measureText(piece).width > w && piece.length > 1) {
        for (const ch of piece) {
          if (cur !== "" && g.measureText(cur + ch).width > w) pushLine();
          cur += ch;
        }
      } else {
        cur += piece;
      }
    }
    if (cur !== "") lines.push(cur.replace(/\s+$/, ""));
  }

  /* 水平锚点。
   * 居中不能直接锚 w/2：canvas 的 textAlign=center 对的是"字宽"(advance)，
   * 而汉字的字面留白左右不对称（右边通常比左边多 1~3 个点），
   * 按字宽居中会整体偏左半根笔画，看上去"没居中"。
   * 这里逐行量真实墨迹的包围盒，把锚点搬到墨迹中心。
   * 左/右对齐仍按字宽锚定——那样多行文字的左边才是一条整齐的竖线。 */
  const anchorOf = (line: string): number => {
    if (el.align !== "center") return el.align === "right" ? w : 0;
    const m = g.measureText(line);
    const l = m.actualBoundingBoxLeft || 0;
    const r = m.actualBoundingBoxRight || 0;
    return w / 2 - (r - l) / 2;
  };

  /* middle 基线对齐的是字体 em 框中心，不是墨迹中心。
   * 汉字几乎没有降部（没有 g、y 那种下伸的笔画），em 框下半部分空着，
   * 所以按 em 居中看上去会偏高约 1/10 字高。
   * 这里用**纯汉字**样本实测墨迹的 ascent/descent，把整体往下补回来。
   * 注意样本不能带 g/y：混进去降部会让上下变得对称，补偿值退化成 0。 */
  const ref = g.measureText("国字");
  const asc = ref.actualBoundingBoxAscent || 0;
  const desc = ref.actualBoundingBoxDescent || 0;
  const opticalFix = (asc - desc) / 2;

  /* 垂直对齐：先算整块文字的总高，再决定第一行的位置。
   * 老模板里可能没有 valign 字段（存在 localStorage 里），
   * 这里兜底成 middle，保证旧模板载入后也是居中的。 */
  const valign = el.valign ?? "middle";
  const blockH = lines.length * lineH;
  const top = valign === "top" ? 0 : valign === "bottom" ? h - blockH : (h - blockH) / 2;

  for (let i = 0; i < lines.length; i++) {
    // middle 基线：第 i 行中心 = 块顶 + (i + 0.5) * 行高
    const cy = top + lineH * (i + 0.5) + opticalFix;
    // 整行都跑到框外的行画了也会被 clip 掉，干脆跳过省点时间
    if (cy + lineH / 2 < 0 || cy - lineH / 2 > h) continue;
    g.fillText(lines[i], anchorOf(lines[i]), cy);
  }
}

/* ------------------------------------------------------------------ 一维码 */

function barcodeKey(el: BarcodeElement, w: number, h: number): string {
  return [
    el.format,
    el.value,
    Math.round(w),
    Math.round(h),
    el.showText ? 1 : 0,
    el.textSizeMm,
  ].join("|");
}

/**
 * 条码明文：把字高收到框宽装得下为止。
 * 一维码的明文往往比码本身宽（EAN13 有 13 位），超了会被左右裁掉，
 * 这里按实测宽度等比缩字，宁小不裁。
 */
function fitBarcodeText(text: string, fontMm: number, boxW: number, ppm: number): number {
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) return fontMm;
  const measure = (mm: number) => {
    probe.font = `${mm * ppm}px "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif`;
    return probe.measureText(text).width;
  };
  const w = measure(fontMm);
  if (w <= boxW || w <= 0) return fontMm;
  return Math.max(1.2, Math.round(fontMm * (boxW / w) * 10) / 10);
}

/**
 * 生成整块条码位图（条 + 明文），尺寸严格等于元素框。
 * ------------------------------------------------------------------
 * 明文不用 JsBarcode 自带的那套绘制，两个坑：
 *   1. 它把基线放在画布最底边（y = height + textMargin + fontSize），
 *      数字的下半截正好被切掉一两个点，打出来是"数字只剩上半个"；
 *   2. 它按 1 倍直接画字，13~16px 的边缘全是灰，二值化后笔画缺角、发毛。
 * 所以条交给库画（整数倍缩放，模块落在整像素上），明文走我们自己的
 * "3 倍超采样 + 覆盖率落墨"管线，跟标签里其他文字一样锐利。
 */
function composeBarcode(
  el: BarcodeElement,
  w: number,
  h: number,
  ppm: number,
  cache: RenderCache
): HTMLCanvasElement | null {
  const value = el.value.trim();
  if (!value) return null;

  const boxW = Math.max(1, Math.round(w));
  const boxH = Math.max(1, Math.round(h));

  /* 明文占的高度：字高 + 上下留白。1.15 是"一字高 + 一点点行距"，
   * 少了数字会贴住条的底边，多了会把条压瘦。 */
  const textH = el.showText ? Math.round(el.textSizeMm * ppm * 1.15) : 0;
  /* 再让 2 个点：条的底边和数字之间不留缝，打出来会粘成一坨，
   * 扫码枪读条时也容易被下面的数字干扰。 */
  const barH = Math.max(4, boxH - textH - (el.showText ? 2 : 0));

  // 第一步：1 像素/模块，量自然宽度
  const probe = document.createElement("canvas");
  try {
    JsBarcode(probe, value, {
      format: el.format,
      width: 1,
      height: 10,
      displayValue: false,
      margin: 0,
      background: "#ffffff",
      lineColor: "#000000",
    });
  } catch {
    return null;
  }

  const naturalW = probe.width || 1;
  // 模块宽度必须整数倍，否则每个条宽不一，扫码枪锁不住
  const scale = Math.max(1, Math.floor(boxW / naturalW));

  // 第二步：只画条，明文交给下面自己画
  const bars = document.createElement("canvas");
  try {
    JsBarcode(bars, value, {
      format: el.format,
      width: scale,
      height: barH,
      displayValue: false,
      margin: 0,
      background: "#ffffff",
      lineColor: "#000000",
    });
  } catch {
    return null;
  }

  // 第三步：合成到元素框大小。条在左右居中，两侧留等宽空白当静区
  const out = document.createElement("canvas");
  out.width = boxW;
  out.height = boxH;
  const g = out.getContext("2d");
  if (!g) return null;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, boxW, boxH);
  g.drawImage(bars, Math.round((boxW - bars.width) / 2), 0);

  if (el.showText && textH > 2) {
    const fontMm = fitBarcodeText(value, el.textSizeMm, boxW, ppm);
    const line: TextElement = {
      id: `${el.id}-text`,
      type: "text",
      x: 0,
      y: 0,
      w: boxW / ppm,
      h: textH / ppm,
      rotate: 0,
      visible: true,
      text: value,
      fontSizeMm: fontMm,
      bold: false,
      align: "center",
      valign: "middle",
      lineHeight: 1,
      wrap: false,
    };
    g.save();
    g.translate(0, boxH - textH);
    drawText(g, line, ppm, boxW, textH, cache);
    g.restore();
  }

  return out;
}

function drawBarcode(
  g: CanvasRenderingContext2D,
  el: BarcodeElement,
  ppm: number,
  w: number,
  h: number,
  cache: RenderCache
) {
  const key = barcodeKey(el, w, h);
  let src: HTMLCanvasElement | null | undefined = cache.barcode.get(key);

  if (!src) {
    src = composeBarcode(el, w, h, ppm, cache);
    if (!src) {
      // 内容不合法（比如 EAN13 位数不对）时画个红叉提示，别静默失败
      g.strokeStyle = "#000";
      g.lineWidth = 1;
      g.strokeRect(0, 0, w, h);
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(w, h);
      g.moveTo(w, 0);
      g.lineTo(0, h);
      g.stroke();
      return;
    }
    cache.barcode.set(key, src);
    // 缓存别无限涨，模板改一次值就多一份
    if (cache.barcode.size > 64) {
      const first = cache.barcode.keys().next().value;
      if (first !== undefined) cache.barcode.delete(first);
    }
  }

  /* 位图就是元素框大小，直接贴左上角。
   * 条的左右居中已经在上一步做完了（两侧等宽空白 = 扫码枪的静区）。 */
  g.drawImage(src, 0, 0);
}

/* ------------------------------------------------------------------ 二维码 */

async function drawQr(
  g: CanvasRenderingContext2D,
  el: QrCodeElement,
  w: number,
  h: number,
  cache: RenderCache
) {
  const size = Math.round(Math.min(w, h));
  const key = `${el.value}|${size}`;
  let src = cache.qrcode.get(key);

  if (!src) {
    const value = el.value || " ";
    /* 模组最好落在整数像素上：qrcode 库按 size/模组数 算比例，
     * 比例是小数时模组会一会儿 3 点、一会儿 4 点，节距不匀，扫码枪更难锁。
     * 但不能一味取整——25 模组、69 点时整数倍只有 50 点，码会小一圈。
     * 所以只在"取整后还能保住 80% 尺寸"时才取整，否则按原尺寸出图。 */
    let px = size;
    try {
      const modules = QRCode.create(value, { errorCorrectionLevel: "M" }).modules.size;
      const k = Math.max(1, Math.floor(size / modules));
      if (modules * k >= size * 0.8) px = modules * k;
    } catch {
      px = size;
    }
    const tmp = document.createElement("canvas");
    try {
      await QRCode.toCanvas(tmp, value, {
        width: px,
        margin: 0,
        errorCorrectionLevel: "M",
        color: { dark: "#000000", light: "#ffffff" },
      });
    } catch {
      return;
    }
    src = tmp;
    cache.qrcode.set(key, src);
    if (cache.qrcode.size > 64) {
      const first = cache.qrcode.keys().next().value;
      if (first !== undefined) cache.qrcode.delete(first);
    }
  }

  // 二维码按正方形生成，元素框不是正方形时居中摆放
  g.drawImage(src, Math.round((w - src.width) / 2), Math.round((h - src.height) / 2));
}

/* ------------------------------------------------------------------ 图片 */

async function drawImage(
  g: CanvasRenderingContext2D,
  el: ImageElement,
  w: number,
  h: number,
  cache: RenderCache
) {
  if (!el.dataUrl) {
    g.strokeStyle = "#000";
    g.setLineDash([4, 4]);
    g.strokeRect(0, 0, w, h);
    g.setLineDash([]);
    return;
  }

  let img = cache.image.get(el.dataUrl);
  if (!img) {
    img = new Image();
    img.src = el.dataUrl;
    try {
      await img.decode();
    } catch {
      return;
    }
    cache.image.set(el.dataUrl, img);
  }

  // 先按 fit 规则算出绘制区域
  const ratio = img.width / img.height;
  let dw = w;
  let dh = h;
  let dx = 0;
  let dy = 0;

  if (el.fit === "contain") {
    if (w / h > ratio) {
      dh = h;
      dw = h * ratio;
      dx = (w - dw) / 2;
    } else {
      dw = w;
      dh = w / ratio;
      dy = (h - dh) / 2;
    }
  } else if (el.fit === "cover") {
    if (w / h > ratio) {
      dw = w;
      dh = w / ratio;
      dy = (h - dh) / 2;
    } else {
      dh = h;
      dw = h * ratio;
      dx = (w - dw) / 2;
    }
  }

  const tmp = document.createElement("canvas");
  tmp.width = Math.max(1, Math.round(w));
  tmp.height = Math.max(1, Math.round(h));
  const tg = tmp.getContext("2d");
  if (!tg) return;

  tg.fillStyle = "#fff";
  tg.fillRect(0, 0, tmp.width, tmp.height);
  tg.drawImage(img, dx, dy, dw, dh);

  // 二值化：照片类走抖动，线条图直接卡阈值，边缘更干净
  if (el.dither) {
    applyFloydSteinberg(tg, tmp.width, tmp.height, el.threshold);
  } else {
    applyThreshold(tg, tmp.width, tmp.height, el.threshold);
  }

  g.drawImage(tmp, 0, 0);
}

function applyThreshold(g: CanvasRenderingContext2D, w: number, h: number, threshold: number) {
  const data = g.getImageData(0, 0, w, h);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    const v = lum >= threshold ? 255 : 0;
    px[i] = px[i + 1] = px[i + 2] = v;
    px[i + 3] = 255;
  }
  g.putImageData(data, 0, 0);
}

/** Floyd-Steinberg 误差扩散，把灰度图打散成黑白点，热敏纸上更像照片 */
function applyFloydSteinberg(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  threshold: number
) {
  const data = g.getImageData(0, 0, w, h);
  const px = data.data;
  const gray = new Float32Array(w * h);

  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    gray[p] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = gray[i];
      const nv = old < threshold ? 0 : 255;
      const err = old - nv;
      gray[i] = nv;

      if (x + 1 < w) gray[i + 1] += (err * 7) / 16;
      if (y + 1 < h) {
        if (x > 0) gray[i + w - 1] += (err * 3) / 16;
        gray[i + w] += (err * 5) / 16;
        if (x + 1 < w) gray[i + w + 1] += err / 16;
      }
    }
  }

  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    const v = gray[p] < threshold ? 0 : 255;
    px[i] = px[i + 1] = px[i + 2] = v;
    px[i + 3] = 255;
  }
  g.putImageData(data, 0, 0);
}
