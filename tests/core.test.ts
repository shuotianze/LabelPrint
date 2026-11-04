import { describe, expect, it } from "vitest";
import {
  centerAlign,
  containerOf,
  placeByCenter,
  resizeKeepCenter,
  MIN_WIDTH_MM,
} from "../src/core/align";
import { mmToDots, dotsPerMm, round1, MM_PER_INCH } from "../src/core/units";
import { sanitizeDoc } from "../src/core/label-doc";

describe("units", () => {
  it("203dpi 下 25.4mm 正好是 203 点", () => {
    expect(mmToDots(MM_PER_INCH, 203)).toBe(203);
  });

  it("不能把 8 当整数系数：100mm 必须按 7.992 算", () => {
    expect(mmToDots(100, 203)).toBe(799);
    expect(dotsPerMm(203)).toBeCloseTo(7.9921, 4);
  });

  it("round1 去掉浮点尾巴", () => {
    expect(round1(29.999999)).toBe(30);
    expect(round1(0.04)).toBe(0);
  });
});

describe("centerAlign", () => {
  it("默认 50mm 容器里居中：30mm 宽的左边是 10", () => {
    const r = centerAlign({ widthMm: 30 });
    expect(r.left).toBe(10);
    expect(r.right).toBe(40);
    expect(r.centerX).toBe(25);
    expect(r.shifted).toBe(false);
  });

  it("贴左时把左侧收进纸内，并标记被挪动过", () => {
    const r = centerAlign({ widthMm: 30, centerMm: 5 });
    expect(r.left).toBe(0);
    expect(r.centerX).toBe(15);
    expect(r.shifted).toBe(true);
  });

  it("元素比纸还宽时左右对称溢出", () => {
    const r = centerAlign({ widthMm: 60, containerMm: 50 });
    expect(r.left).toBe(-5);
    expect(r.right).toBe(55);
    expect(r.overflowMm).toBe(10);
  });

  it("宽度小于下限会被抬到 1mm", () => {
    const r = centerAlign({ widthMm: 0 });
    expect(r.widthMm).toBe(MIN_WIDTH_MM);
  });

  it("留边生效：左右各让 2mm 后可用宽度变 46", () => {
    const r = centerAlign({ widthMm: 40, gutterMm: 2 });
    expect(r.gutterMm).toBe(2);
    // 居中时左边 = 50/2 - 20 = 5，右边 = 45，可用宽度 46
    expect(r.left).toBe(5);
    expect(r.right).toBe(45);
  });

  it("containerOf 取纸宽与打印头宽度里小的那个", () => {
    // 400 点 @203dpi ≈ 50.05mm，比 50mm 纸宽大，所以取 50
    const paper = { widthMm: 50, heightMm: 30, dpi: 203, printheadDots: 400 };
    expect(containerOf(paper)).toBe(50);
    // 384 点 ≈ 48.05mm，此时取打印头宽度
    expect(containerOf({ ...paper, printheadDots: 384 })).toBeCloseTo(48.047, 3);
  });
});

describe("placeByCenter / resizeKeepCenter", () => {
  it("改宽度时中心不动", () => {
    const el = { x: 10, y: 0, w: 30, h: 10 };
    const before = el.x + el.w / 2;
    resizeKeepCenter(el, 40, { containerMm: 50 });
    expect(el.x).toBe(5);
    expect(el.w).toBe(40);
    expect(el.x + el.w / 2).toBe(before);
  });

  it("超出纸宽时被夹住，宽度本身不缩水", () => {
    const el = { x: 0, y: 0, w: 30, h: 10 };
    resizeKeepCenter(el, 60, { containerMm: 50 });
    expect(el.w).toBe(60);
    expect(el.x).toBe(-5);
  });

  it("placeByCenter 可以同时指定中心和宽度", () => {
    const el = { x: 0, y: 0, w: 30, h: 10 };
    placeByCenter(el, { widthMm: 20, centerMm: 10, containerMm: 50 });
    expect(el.w).toBe(20);
    expect(el.x).toBe(0);
  });
});

describe("sanitizeDoc", () => {
  it("补齐缺失字段", () => {
    const doc = sanitizeDoc({
      paper: { widthMm: 50, heightMm: 30 },
      elements: [{ type: "text", x: 3, y: 4 }],
    });
    expect(doc).not.toBeNull();
    const el = doc!.elements[0];
    expect(el.type).toBe("text");
    expect(el.x).toBe(3);
    expect(el.y).toBe(4);
    expect(el.rotate).toBe(0);
    expect(el.visible).toBe(true);
    // 文字元素缺内容时给默认文案，缺字高给 3.5
    expect((el as { text: string }).text).toBe("文字");
    expect((el as { fontSizeMm: number }).fontSizeMm).toBeCloseTo(3.5);
  });

  it("纸宽纸高非法时回退到默认值", () => {
    const doc = sanitizeDoc({ paper: { widthMm: -1, heightMm: "abc" }, elements: [] });
    expect(doc!.paper.widthMm).toBe(50);
    expect(doc!.paper.heightMm).toBe(30);
  });

  it("类型不认识的元素被丢弃，坏元素不会拖垮整份文档", () => {
    const doc = sanitizeDoc({
      paper: { widthMm: 50, heightMm: 30 },
      elements: [{ type: "unknown" }, null, { type: "rect", w: 10, h: 5 }],
    });
    expect(doc!.elements).toHaveLength(1);
    expect(doc!.elements[0].type).toBe("rect");
  });

  it("非法旋转角度收敛为 0", () => {
    const doc = sanitizeDoc({
      paper: { widthMm: 50, heightMm: 30 },
      elements: [{ type: "line", rotate: 45 }],
    });
    expect(doc!.elements[0].rotate).toBe(0);
  });

  it("不是对象或没有纸型时返回 null", () => {
    expect(sanitizeDoc(null)).toBeNull();
    expect(sanitizeDoc({ elements: [] })).toBeNull();
  });
});
