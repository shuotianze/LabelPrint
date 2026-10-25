/**
 * 内置预设模板
 * ------------------------------------------------------------------
 * 做法：每个模板先按 **48×30mm 的基准纸** 写死坐标（B1 最常用的纸型），
 * 再由 adapt() 缩放到用户当前纸张。
 *
 * 版式纪律（所有模板统一遵守，改模板时照着来）：
 *   1. 内容区 44×26mm（左右各留 2mm 边，B1 送纸有轻微偏移，不能贴边）
 *   2. 信息类文字一律左对齐 + 左边界对齐到 2mm，形成一条竖线
 *   3. 层级只用三档字号：标题 2.5~3.0 / 正文 2.2~2.3 / 注释 2.0（下限）（mm）
 *   4. 分区之间用 0.3mm 细线分隔，不用大片留白（纸太小，留白浪费）
 *   5. 二维码不小于 7.5mm、一维码不小于 6mm 高，否则扫不出来
 *
 * 缩放下限 0.45、放大上限：内容区 2 倍、字号 1.3 倍。
 * 字号不跟着放太多，否则连续纸 48×80 上会出现"巨型字配小框"。
 */
import {
  createBarcode,
  createLine,
  createQrCode,
  createRect,
  createText,
  sampleDoc,
  type LabelDoc,
  type LabelElement,
  type PaperSetup,
} from "./label-doc";
import { round1 } from "./units";

/** 基准纸尺寸，所有模板坐标都按这个写 */
const DW = 48;
const DH = 30;
/** 通用外边距 */
const PAD = 2;
/** 内容区宽度：48 - 2*2 */
const CW = DW - PAD * 2;
/** 基准纸的几何中心：所有"居中"元素共享这一条竖线 */
const CX = DW / 2;

/**
 * 按中心点推左边界：左 = 中心 - 宽 / 2。
 * 宽 44（满内容区）→ 左 2；宽 34（分隔线）→ 左 7。
 * 两者宽度差 10mm，中心都是 24mm —— 这就是"以中间点为基准"的意思。
 */
const byCenter = (w: number) => round1(CX - w / 2);

/**
 * 模板允许的最小字高（mm）。
 * 203dpi 热敏纸上 2.0mm 约合 16 个点，笔画分开、离半米也能读；
 * 再小（1.4~1.5）打完会粘连成一团墨，所以 adapt() 里做兜底。
 */
const MIN_FONT_MM = 2.0;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * 把基准纸上的排版搬到现在这张纸上。
 * 横向、纵向分别缩放（纸型宽高比不同也不挤），字号取两者较小的那个。
 */
function adapt(paper: PaperSetup, name: string, design: LabelElement[]): LabelDoc {
  /* 排版只在**可打印宽度**内展开。
   * 纸 50mm、打印头只有 48mm 时，右边 2mm 是打不到的，
   * 如果按 50mm 排，二维码会被切掉一条边直接扫不出来。 */
  const headMm = (paper.printheadDots * 25.4) / paper.dpi;
  const layoutW = Math.min(paper.widthMm, headMm);

  const sx = clamp((layoutW - PAD * 2) / CW, 0.45, 1.5);
  const sy = clamp((paper.heightMm - PAD * 2) / (DH - PAD * 2), 0.45, 2);
  const fs = clamp(Math.min(sx, sy), 0.45, 1.3);

  const mapX = (v: number) => PAD + (v - PAD) * sx;
  const mapY = (v: number) => PAD + (v - PAD) * sy;

  const elements = design.map((src) => {
    const el = { ...src } as LabelElement;
    el.x = round1(mapX(src.x));
    el.y = round1(mapY(src.y));
    el.w = round1(src.w * sx);
    el.h = round1(src.h * sy);

    /* 字号兜底只在"纸型接近基准纸"时生效。
     * 缩得太狠（fs < 0.9，比如 40×20 上内容只剩 0.62 倍）时行距本来就不够，
     * 硬把字抬到 1.7mm 会让相邻两行叠在一起，反而更难读——这种情况按比例缩。 */
    const floorFont = (mm: number) =>
      fs >= 0.9 ? Math.max(MIN_FONT_MM, round1(mm * fs)) : round1(mm * fs);

    if (el.type === "text") {
      el.fontSizeMm = floorFont((src as typeof el).fontSizeMm);
      /* 字号被兜底放大后，外框也得装得下，否则字被上下裁掉。
       * 1.45 倍字高是"一行字 + 一点行间余量"的经验值。 */
      if (fs >= 0.9) {
        const needH = round1(el.fontSizeMm * 1.45);
        const room = round1(paper.heightMm - el.y);
        if (el.h < needH && room > el.h) el.h = Math.min(needH, room);
      }
    }
    if (el.type === "barcode") {
      el.textSizeMm = floorFont((src as typeof el).textSizeMm);
    }

    // 二维码必须方：横纵缩放比不同会让模组变成矩形，扫不出来
    if (el.type === "qrcode") {
      const side = Math.min(el.w, el.h);
      el.x = round1(el.x + (el.w - side) / 2);
      el.y = round1(el.y + (el.h - side) / 2);
      el.w = side;
      el.h = side;
    }

    // 细线缩放后至少留 1 个点，否则 203dpi 下画不出来
    if (el.type === "line") {
      el.thicknessMm = Math.max(0.12, src.type === "line" ? src.thicknessMm * Math.min(sx, sy) : 0.3);
      el.h = Math.max(el.thicknessMm, el.h);
    }

    // 兜底：任何元素都不许跑到纸外（横向按可打印宽度算）
    el.x = Math.max(0, el.x);
    el.y = Math.max(0, el.y);
    el.w = Math.min(el.w, layoutW - el.x);
    el.h = Math.min(el.h, paper.heightMm - el.y);
    return el;
  });

  return { version: 1, name, paper, elements };
}

/* ---------------------------------------------------------------- 以下坐标均按 48×30 写 */

/**
 * 物料标签
 * 左：名称 / 规格 / 数量 / 批次，右上二维码，底部满宽条码。
 * 名称用 3.0mm 粗体做视觉锚点，下面三行同字号，读起来是一条竖线。
 */
function material(paper: PaperSetup): LabelDoc {
  return adapt(paper, "物料标签", [
    createText({ text: "物料名称", x: PAD, y: 1.8, w: 27, h: 5.4, fontSizeMm: 3.0, bold: true, align: "left" }),
    createText({ text: "规格 40×40×2", x: PAD, y: 7.4, w: 27, h: 4.0, fontSizeMm: 2.3, align: "left" }),
    createText({ text: "数量 100 件", x: PAD, y: 11.6, w: 27, h: 4.0, fontSizeMm: 2.3, align: "left" }),
    createText({ text: "批次 2026-10-24", x: PAD, y: 15.4, w: 27, h: 3.4, fontSizeMm: 2.0, align: "left" }),
    createQrCode({ x: 30.5, y: 1.8, w: 15.5, h: 15.5, value: "SF-2026-001" }),
    /* 分隔线必须落在"批次"这行文字的下面。文字框 h3.4、字号 1.8，
     * 实际墨迹到 18.0 左右，线放 18.9 才不会穿字。 */
    createLine({ x: PAD, y: 18.9, w: CW, h: 0.3, thicknessMm: 0.3 }),
    createBarcode({
      x: PAD,
      y: 19.2,
      w: CW,
      h: 8.8,
      value: "SF2026001",
      showText: true,
      textSizeMm: 2.0,
    }),
  ]);
}

/**
 * 配件发货单（带广告）
 * 上半张是单据内容，下半张是一条带边框的广告位：品牌 + 口号 + 二维码。
 * 广告位固定在底部并加框，贴到包装箱上时不会被人当成正文忽略。
 */
function partsShip(paper: PaperSetup): LabelDoc {
  return adapt(paper, "配件发货单", [
    createText({ text: "配件发货单", x: PAD, y: 1.3, w: 24, h: 4.2, fontSizeMm: 2.6, bold: true, align: "left" }),
    createText({
      text: "NO.F261024-01",
      x: 26,
      y: 1.8,
      w: 20,
      h: 3.2,
      fontSizeMm: 2.0,
      align: "right",
    }),
    createLine({ x: PAD, y: 5.9, w: CW, h: 0.3, thicknessMm: 0.3 }),

    createText({ text: "客户 杭州某某自动化", x: PAD, y: 6.3, w: CW, h: 3.2, fontSizeMm: 2.0, align: "left" }),
    createText({ text: "项目 龙门改造 · 合同 HT-2026-88", x: PAD, y: 9.5, w: CW, h: 3.2, fontSizeMm: 2.0, align: "left" }),
    createText({
      text: "配件 驱动板×2 · 限位开关×5 · 屏蔽线束×1",
      x: PAD,
      y: 12.7,
      w: CW,
      h: 4.4,
      fontSizeMm: 2.0,
      align: "left",
      valign: "top",
      wrap: true,
    }),
    createText({ text: "合计 8 件 · 2026-10-24", x: PAD, y: 17.4, w: CW, h: 3.2, fontSizeMm: 2.0, align: "left" }),

    /* 广告位：不画外框（打出来会变成一圈黑边，太抢眼），
     * 只用一条细线跟正文分开，左侧两行文案，右侧二维码。
     * 二维码 7.8mm 是底线——再小模组就落在非整数像素上，手机扫不动。 */
    createLine({ x: PAD, y: 20.9, w: CW, h: 0.3, thicknessMm: 0.3 }),
    createText({
      text: "朔有趣 · 工控配件一站配齐",
      x: PAD,
      y: 21.6,
      w: 33,
      h: 3.6,
      fontSizeMm: 2.1,
      bold: true,
      align: "left",
    }),
    createText({
      text: "扫码自助下单 shuo.fun",
      x: PAD,
      y: 25.4,
      w: 33,
      h: 3.0,
      fontSizeMm: 2.0,
      align: "left",
    }),
    createQrCode({ x: 37.2, y: 21.2, w: 8.6, h: 8.6, value: "shuo.fun" }),
  ]);
}

/**
 * 资产标签
 * 大写编号 + 名称 + 责任人，右上二维码，底部满宽条码。
 */
function asset(paper: PaperSetup): LabelDoc {
  return adapt(paper, "资产标签", [
    createText({ text: "A-0123", x: PAD, y: 1.6, w: 30, h: 7.6, fontSizeMm: 4.4, bold: true, align: "left" }),
    createText({ text: "笔记本电脑 · 研发部", x: PAD, y: 9.4, w: 30, h: 4.0, fontSizeMm: 2.2, align: "left" }),
    createText({ text: "责任人 王工 · 2026-10", x: PAD, y: 13.6, w: 30, h: 3.6, fontSizeMm: 2.0, align: "left" }),
    createQrCode({ x: 33.5, y: 1.6, w: 13, h: 13, value: "ZC2026000123" }),
    createLine({ x: PAD, y: 18.0, w: CW, h: 0.3, thicknessMm: 0.3 }),
    createBarcode({
      x: PAD,
      y: 18.4,
      w: CW,
      h: 9.6,
      value: "ZC2026000123",
      showText: true,
      textSizeMm: 2.0,
    }),
  ]);
}

/**
 * 设备维修标签（完整版）
 * 设备名做视觉锚点，型号/故障/维修/保养四行分开写（便于现场填改），
 * 右侧二维码直达维修档案，底部一行送修/完成日期。
 * 不放一维码：这张是贴在设备上的"看板"，扫码即可，条码反而占掉两行信息位。
 */
function repair(paper: PaperSetup): LabelDoc {
  return adapt(paper, "设备维修标签", [
    createText({ text: "设备维修记录", x: PAD, y: 1.2, w: 26, h: 4.2, fontSizeMm: 2.5, bold: true, align: "left" }),
    createText({ text: "已修复", x: 28, y: 1.5, w: 18, h: 3.6, fontSizeMm: 2.0, bold: true, align: "right" }),
    createLine({ x: PAD, y: 5.9, w: CW, h: 0.3, thicknessMm: 0.3 }),

    createText({ text: "注塑机 3#", x: PAD, y: 6.5, w: 28, h: 5.0, fontSizeMm: 2.6, bold: true, align: "left" }),
    createText({ text: "型号 MVC030 · 2.2kW", x: PAD, y: 11.8, w: 28, h: 3.2, fontSizeMm: 2.1, align: "left" }),
    createText({ text: "故障 过流报警 E07", x: PAD, y: 15.4, w: 28, h: 3.2, fontSizeMm: 2.1, align: "left" }),
    createText({ text: "维修 更换驱动板 · 李工", x: PAD, y: 19.0, w: 28, h: 3.2, fontSizeMm: 2.1, align: "left" }),
    createText({ text: "保养 2027-04-24 · 季度", x: PAD, y: 22.6, w: 28, h: 3.2, fontSizeMm: 2.1, align: "left" }),

    createQrCode({ x: 31.6, y: 6.5, w: 14.2, h: 14.2, value: "SB-M-2026-1024" }),

    createLine({ x: PAD, y: 26.4, w: CW, h: 0.3, thicknessMm: 0.3 }),
    createText({
      text: "送修 2026-10-20 · 完成 2026-10-24",
      x: PAD,
      y: 26.9,
      w: CW,
      h: 2.8,
      fontSizeMm: 2.0,
      align: "left",
    }),
  ]);
}

/**
 * 库位标签
 * 外框 + 远处可读的大号库位号 + 右下二维码。
 * 这张是"隔着两米也要看清"的用途，所以字号是全部模板里最大的。
 */
function shelf(paper: PaperSetup): LabelDoc {
  return adapt(paper, "库位标签", [
    createRect({ x: 0.6, y: 0.6, w: 46.8, h: 28.8, filled: false, strokeMm: 0.5 }),
    createText({
      text: "仓库 1F · A 区",
      x: PAD + 1,
      y: 1.9,
      w: 26,
      h: 3.6,
      fontSizeMm: 2.0,
      bold: true,
      align: "left",
    }),
    createText({ text: "A-03-12", x: PAD + 1, y: 6.4, w: 31, h: 11.4, fontSizeMm: 5.6, bold: true, align: "left" }),
    createText({
      text: "高位货架 3 层",
      x: PAD + 1,
      y: 18.6,
      w: 31,
      h: 3.4,
      fontSizeMm: 2.0,
      align: "left",
    }),
    createQrCode({ x: 35.6, y: 16.2, w: 9.8, h: 9.8, value: "A-03-12" }),
  ]);
}

/**
 * 价格标签
 * 品名 → 大价格（右侧跟单位）→ 日期 → 满宽 EAN-13。
 */
function price(paper: PaperSetup): LabelDoc {
  return adapt(paper, "价格标签", [
    createText({ text: "商品名称", x: PAD, y: 1.8, w: CW, h: 4.0, fontSizeMm: 2.3, align: "left" }),
    createText({ text: "¥12.90", x: PAD, y: 5.9, w: 32, h: 9.6, fontSizeMm: 5.6, bold: true, align: "left" }),
    createText({ text: "元/件", x: 34, y: 9.0, w: 12, h: 4.0, fontSizeMm: 2.2, align: "right" }),
    createText({ text: "2026-10-24 · 特价", x: PAD, y: 16.2, w: CW, h: 3.4, fontSizeMm: 2.0, align: "left" }),
    createLine({ x: PAD, y: 20.0, w: CW, h: 0.3, thicknessMm: 0.3 }),
    createBarcode({
      x: PAD,
      y: 20.4,
      w: CW,
      h: 8.2,
      value: "6901234567892",
      format: "EAN13",
      showText: true,
      textSizeMm: 2.0,
    }),
  ]);
}

/** 快递面单：收件人 + 地址 + 满宽运单条码 */
function shipping(paper: PaperSetup): LabelDoc {
  return adapt(paper, "快递面单", [
    createText({
      text: "张三  138****8888",
      x: PAD,
      y: 1.6,
      w: CW,
      h: 5.0,
      fontSizeMm: 2.5,
      bold: true,
      align: "left",
    }),
    /* 地址框只留两行的高度（字号 2.2、行距 1.3 → 每行约 2.9mm），
     * 多给的部分会把分隔线和条码往下顶，白白浪费一张纸的版面。 */
    createText({
      text: "浙江省杭州市余杭区文一西路 969 号 3 号楼 502",
      x: PAD,
      y: 7.2,
      w: CW,
      h: 6.6,
      fontSizeMm: 2.2,
      align: "left",
      valign: "top",
      wrap: true,
    }),
    createLine({ x: PAD, y: 15.0, w: CW, h: 0.3, thicknessMm: 0.3 }),
    createBarcode({
      x: PAD,
      y: 15.4,
      w: CW,
      h: 12.4,
      value: "SF1234567890123",
      showText: true,
      textSizeMm: 2.0,
    }),
  ]);
}

/** 合格证：外框 + 大字"合格" + 检验员/日期分列两边 */
function passTag(paper: PaperSetup): LabelDoc {
  return adapt(paper, "合格证", [
    createRect({ x: 0.6, y: 0.6, w: 46.8, h: 28.8, filled: false, strokeMm: 0.5 }),
    /* 标题（宽 44）和分隔线（宽 34）宽度差 10mm，
     * 但都按中心线 24mm 推左边界 → 中心严格对齐，不会一左一右歪着。 */
    createText({ text: "合 格", x: byCenter(CW), y: 4.4, w: CW, h: 12.8, fontSizeMm: 6.4, bold: true }),
    createLine({ x: byCenter(34), y: 18.2, w: 34, h: 0.3, thicknessMm: 0.3 }),
    createText({ text: "检验员 01", x: PAD, y: 19.2, w: 21, h: 3.4, fontSizeMm: 2.0, align: "left" }),
    createText({ text: "2026-10-24", x: 23, y: 19.2, w: 23, h: 3.4, fontSizeMm: 2.0, align: "right" }),
  ]);
}

/** 扫码名片：左边二维码，右边品牌 + 网址 + 一句话介绍 */
function card(paper: PaperSetup): LabelDoc {
  return adapt(paper, "扫码名片", [
    createQrCode({ x: 3, y: 6, w: 18, h: 18, value: "https://shuo.fun" }),
    createText({
      text: "朔有趣",
      x: 23,
      y: 4.4,
      w: 22,
      h: 6.4,
      fontSizeMm: 3.2,
      bold: true,
      align: "left",
    }),
    createText({ text: "shuo.fun", x: 23, y: 11.2, w: 22, h: 4.2, fontSizeMm: 2.3, align: "left" }),
    createText({
      text: "工业配件 · 工控方案",
      x: 23,
      y: 16.0,
      w: 22,
      h: 4.2,
      fontSizeMm: 2.0,
      align: "left",
    }),
    createText({ text: "扫码访问", x: 23, y: 20.6, w: 22, h: 3.4, fontSizeMm: 2.0, align: "left" }),
  ]);
}

/** 日期标签：生产日期 + 保质期，食品/化工常用 */
function dateTag(paper: PaperSetup): LabelDoc {
  return adapt(paper, "日期标签", [
    createText({ text: "生产日期", x: PAD, y: 1.6, w: CW, h: 3.6, fontSizeMm: 2.0, align: "left" }),
    createText({ text: "2026-10-24", x: PAD, y: 5.2, w: CW, h: 10.8, fontSizeMm: 4.4, bold: true, align: "left" }),
    createLine({ x: PAD, y: 17.2, w: CW, h: 0.3, thicknessMm: 0.3 }),
    createText({ text: "保质期至", x: PAD, y: 17.8, w: 20, h: 3.4, fontSizeMm: 2.0, align: "left" }),
    createText({ text: "2027-10-23", x: PAD, y: 21.2, w: CW, h: 5.8, fontSizeMm: 3.0, bold: true, align: "left" }),
  ]);
}

/** 线缆标签：设备编号 + 位置 + 满宽条码，窄长纸也能用 */
function cable(paper: PaperSetup): LabelDoc {
  return adapt(paper, "线缆标签", [
    createText({
      text: "设备编号 M-07",
      x: PAD,
      y: 1.8,
      w: CW,
      h: 4.6,
      fontSizeMm: 2.4,
      bold: true,
      align: "left",
    }),
    createText({ text: "MCC 柜 3 号 · 进线", x: PAD, y: 6.6, w: CW, h: 4.0, fontSizeMm: 2.2, align: "left" }),
    createText({ text: "2026-10-24 投运", x: PAD, y: 10.8, w: CW, h: 3.4, fontSizeMm: 2.0, align: "left" }),
    createLine({ x: PAD, y: 15.0, w: CW, h: 0.3, thicknessMm: 0.3 }),
    createBarcode({
      x: PAD,
      y: 15.6,
      w: CW,
      h: 12.4,
      value: "M-07",
      showText: true,
      textSizeMm: 2.0,
    }),
  ]);
}

/** 空白：只保留纸张，方便从零搭 */
function blank(paper: PaperSetup): LabelDoc {
  return { version: 1, name: "空白", paper, elements: [] };
}

/* ---------------------------------------------------------------- 导出 */

interface Preset {
  key: string;
  label: string;
  build: (paper: PaperSetup) => LabelDoc;
}

export const BUILTIN_PRESETS: Preset[] = [
  { key: "material", label: "物料标签", build: material },
  { key: "parts", label: "配件发货单（带广告）", build: partsShip },
  { key: "asset", label: "资产标签", build: asset },
  { key: "repair", label: "设备维修标签", build: repair },
  { key: "shelf", label: "库位标签", build: shelf },
  { key: "price", label: "价格标签", build: price },
  { key: "shipping", label: "快递面单", build: shipping },
  { key: "pass", label: "合格证", build: passTag },
  { key: "card", label: "扫码名片", build: card },
  { key: "date", label: "日期标签", build: dateTag },
  { key: "cable", label: "线缆标签", build: cable },
  { key: "blank", label: "空白", build: blank },
];

/** 按 key 取模板；key 不存在时回退到示例模板，避免界面空白 */
export function buildPreset(key: string, paper: PaperSetup): LabelDoc {
  const p = BUILTIN_PRESETS.find((x) => x.key === key);
  if (!p) return sampleDoc({ ...paper });
  return p.build({ ...paper });
}
