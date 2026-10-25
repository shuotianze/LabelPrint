/**
 * 打印流程封装
 * ------------------------------------------------------------------
 * 协议栈已经把"图片 → 打印机指令"这一整套做好了，这里只负责：
 * 把画布编码成点位图 → 建打印任务 → 逐页发送 → 等打印结束。
 * 顺序不能乱：printInit 必须在 printPage 之前，printEnd 无论成功失败都要发，
 * 否则打印机下次会以为自己还在上一次任务里。
 */
import { ImageEncoder, PageColorType } from "@mmote/niimbluelib";
import type { LabelType, PrintTaskName } from "@mmote/niimbluelib";
import type { TauriBleClient } from "../transport/blec-client";
import { binarize } from "../render/render-label";

export interface PrintOptions {
  /** 浓度 1~5（各机型范围不同，取 meta.densityMin/Max）。
   * 注意：原厂固件不把这个值接到打印头，实际黑度由固件里的能量系数决定；
   * 我们自己刷的补丁固件已经把系数拉高，这里下发只为协议完整。 */
  density: number;
  /** 标签类型：间隙纸 / 黑标纸 / 连续纸 */
  labelType: LabelType;
  /** 份数 */
  quantity: number;
}

export type ProgressHandler = (stage: string, detail?: string) => void;

/** 把画布打印出来 */
export async function printCanvas(
  client: TauriBleClient,
  canvas: HTMLCanvasElement,
  opts: PrintOptions,
  onProgress: ProgressHandler = () => undefined
): Promise<void> {
  if (!client.isConnected()) {
    throw new Error("打印机未连接");
  }

  const taskName: PrintTaskName | undefined = client.getPrintTaskType();
  if (!taskName) {
    throw new Error("识别不到机型，无法选择打印任务");
  }

  const meta = client.getModelMetadata();
  const printDirection = meta?.printDirection ?? "top";

  onProgress("编码位图");
  /* 编码前再落一次墨。预览里已经做过了，这里是保险：
   * 编码器把"任何非纯白"都当黑点，只要混进一个抗锯齿灰边，
   * 粗体就会糊成一片。宁可多跑一遍 96k 像素，也不要打出脏字。 */
  binarize(canvas);
  const encoded = ImageEncoder.encodeCanvas(canvas, PageColorType.SingleColor, printDirection);

  const task = client.protocol.newPrintTask(taskName, {
    density: opts.density,
    labelType: opts.labelType,
    totalPages: opts.quantity,
    statusPollIntervalMs: 500,
    statusTimeoutMs: 8000,
    // 库默认 10s，384 点宽的一页在慢速 BLE 上可能不够，放宽到 30s
    pageTimeoutMs: 30000,
    pageColor: encoded.pageColor,
  });

  /* 每行点数决定"像素计数"怎么分包（拆 3 组还是整行报总数）。
   * 库默认取机型表里的 384 点，但位图宽度是按纸宽算的（48mm=384、50mm=400），
   * 分包宽度跟位图对不上会把计数算歪，所以强制改成画布实际宽度。 */
  (task as unknown as { printheadPixels: () => number }).printheadPixels = () => canvas.width;

  /* 打印期间必须停掉心跳。
   * 心跳和打印共用同一条 BLE 链路和同一把锁，打印时打印机忙着走纸不回复心跳，
   * 累积失败会让库主动断开连接（这正是"设备自己断开"的根源之一）。
   * 打印结束再恢复；打印过程中打印机不会休眠，停掉是安全的。 */
  client.stopHeartbeat();

  try {
    onProgress("握手");
    await task.printInit();

    onProgress("发送数据");
    await task.printPage(encoded, opts.quantity);
    await task.waitForPageFinished();

    onProgress("等待打印完成");
    await task.waitForFinished();
    onProgress("完成");
  } finally {
    // 不管成功还是出错，都要收尾，否则打印机停在半开状态
    await task.printEnd().catch(() => undefined);
    // 连接还在才恢复心跳，已经掉线就别再制造失败计数
    if (client.isConnected()) client.startHeartbeat();
  }
}
