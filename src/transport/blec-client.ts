/**
 * Tauri BLE 传输适配器
 * ------------------------------------------------------------------
 * niimbluelib 把所有打印机协议（命令封装、分包、抖动、打印任务状态机）
 * 都写在 NiimbotAbstractClient 里，抽象层只要求子类实现 4 个方法：
 *   connect / disconnect / isConnected / sendRaw
 * 这里用 tauri-plugin-blec 的 API 实现它们，于是同一套协议代码
 * 可以在 Windows / macOS / Linux / Android / iOS 上跑。
 *
 * 蓝牙细节全部照着官方 bluetooth_impl.js 写，不自己发明：
 *   - Service UUID 固定为 e7810a71-...
 *   - 特征值不硬编码，动态找"支持 notify + 无应答写"的那个
 *   - 每次写入之间 sleep(packetIntervalMs)，否则打印到一半会丢包
 *   - 连上之后必须 emit("connect")，父类靠这个事件启动心跳
 */
/* 必须从包根入口引入，不能深挖 dist/cjs/xxx 子路径。
 * 原因：库里存在 require(".") 自引用循环（bluetooth_impl → client/index），
 * 深路径导入会让 Vite 把它们拆成两个独立 chunk，各自持有一份模块副本，
 * 于是 NiimbotAbstractClient 在另一份里还是 undefined，
 * 运行时直接抛 "Class extends value undefined is not a constructor"。 */
import {
  NiimbotAbstractClient,
  ConnectResult,
  ConnectEvent,
  DisconnectEvent,
  RawPacketSentEvent,
} from "@mmote/niimbluelib";
import type { ConnectionInfo, NiimbotClientType, PaperInfo } from "@mmote/niimbluelib";
import * as blec from "@mnlphlp/plugin-blec";

/** 精臣打印机的蓝牙服务 UUID（所有机型通用） */
export const NIIMBOT_SERVICE_UUID = "e7810a71-73ae-499d-8c15-faa9aef0c3f2";

/** GATT 特征值属性位（蓝牙标准定义） */
const PROP_WRITE_WITHOUT_RESPONSE = 0x04;
const PROP_NOTIFY = 0x10;

/** 机型名称前缀：B1/B21 以 B 开头，D11/D110 以 D 开头，H1S 以 H 开头 */
const MODEL_NAME_PREFIXES = ["B", "D", "H", "K"];

/** 扫描到的一台设备 */
export interface DiscoveredDevice {
  address: string;
  name: string;
  rssi: number;
}

/**
 * 判断这个广播名字像不像精臣打印机
 * 官方用名称首字母过滤，这里保持一致（避免列表里全是耳机手环）
 */
export function looksLikeNiimbot(name: string): boolean {
  if (!name) return false;
  return MODEL_NAME_PREFIXES.some((p) => name.toUpperCase().startsWith(p));
}

/**
 * 扫描周边蓝牙设备
 *
 * 注意：startScan 在 Rust 侧是 handler.discover(...).await，
 * 它会一直阻塞到 timeout 结束才返回，调用方不需要再额外等待一遍。
 *
 * @param onUpdate 每次发现新设备回调一次（累计去重后的全量列表）
 * @param timeoutMs 扫描时长
 */
/**
 * 确保蓝牙运行时权限已授予。
 *
 * 安卓 12+ 把蓝牙拆成 BLUETOOTH_SCAN / BLUETOOTH_CONNECT 两个"危险权限"，
 * 必须在运行时向用户弹窗申请。不申请就直接扫，系统**不会报错**，
 * 只是永远扫不到任何设备——这就是"手机上扫不到蓝牙"的真正原因。
 * 桌面端没有这个概念，checkPermissions 直接返回 true。
 */
async function ensurePermissions(): Promise<void> {
  const granted = await blec
    .checkPermissions(true)
    .catch(() => true); // 桌面端某些平台没实现这个命令，直接放行
  if (!granted) {
    throw new Error(
      "没有蓝牙权限，无法扫描。请到「系统设置 → 应用 → 标签打印 → 权限」里允许「附近的设备」" +
        "（安卓 11 及以下叫「位置信息」），然后回来再点一次扫描"
    );
  }
}

export async function scanDevices(
  onUpdate: (devices: DiscoveredDevice[]) => void,
  timeoutMs = 8000
): Promise<void> {
  await ensurePermissions();

  const found = new Map<string, DiscoveredDevice>();
  const flush = () => {
    onUpdate([...found.values()].sort((a, b) => b.rssi - a.rssi));
  };

  const state = await blec.getAdapterState();
  if (state === "Off") {
    throw new Error("蓝牙适配器没有打开，请先在系统里打开蓝牙");
  }

  await blec.startScan((batch) => {
    for (const d of batch) {
      found.set(d.address, { address: d.address, name: d.name, rssi: d.rssi });
    }
    flush();
  }, timeoutMs);

  // 最后几包可能还在 Channel 投递队列里，留一小段时间收尾（不是把整个 timeout 再等一遍）
  await new Promise((r) => setTimeout(r, 250));
  await blec.stopScan().catch(() => undefined);
  flush();
}

/**
 * 打印机客户端：把 blec 当作"串口"，接到 niimbluelib 的协议栈上
 */
export class TauriBleClient extends NiimbotAbstractClient {
  private conn: blec.BleConnection | null = null;
  private charUuid: string | null = null;
  private serviceUuid: string = NIIMBOT_SERVICE_UUID;
  private deviceName = "";
  private lastAddress: string | null = null;

  constructor() {
    super();

    /* 治"设备自己断开"的关键一处。
     * 库的 fetchHeartbeatData 一旦连续失败 heartbeatMaxFails 次就主动 disconnect，
     * 默认 5 次 × 2 秒 = 10 秒，打印时打印机忙着走纸，心跳包很容易超时，
     * 于是打到一半连接被库自己掐掉，表现就是"设备自动断开"。
     *
     * 注意 setHeartbeatMaxFails(0) 并不能关掉这个行为：库里的判断是
     *   fails > 0 && fails >= maxFails
     * 传 0 反而变成"第一次失败就断"。所以这里给一个足够大的数，等于关闭。 */
    this.setHeartbeatMaxFails(100000);
    this.setHeartbeatInterval(4000);
  }

  /** 读打印机当前的纸张信息（高/宽/间隙），用于"读取当前纸"按钮 */
  async readPaperInfo(): Promise<PaperInfo> {
    if (!this.isConnected()) throw new Error("打印机未连接");
    return this.protocol.getPaperInfo();
  }

  /** 当前连接状态（父类的 abstract 要求） */
  isConnected(): boolean {
    return this.conn !== null && this.charUuid !== null;
  }

  getType(): NiimbotClientType {
    return "bluetooth";
  }

  /**
   * 连接打印机并完成握手（读型号/版本/电量）
   * @param address 目标设备地址
   * @param name 设备广播名，仅用于界面显示
   */
  async connect(address?: string, name?: string): Promise<ConnectionInfo> {
    const addr = address ?? this.lastAddress;
    if (!addr) throw new Error("没有指定要连接的设备");
    this.lastAddress = addr;

    // 安卓上连接同样要 BLUETOOTH_CONNECT，扫描时给过就不弹第二次
    await ensurePermissions();

    await this.disconnect();

    const conn = await blec.connect(addr, () => {
      // 打印机被别的设备抢走、或超时休眠，都会走到这里
      this.conn = null;
      this.charUuid = null;
      this.emit("disconnect", new DisconnectEvent());
    });

    // 找"支持 notify + 无应答写"的特征值，与官方 findSuitableBluetoothCharacteristic 一致
    const services = await conn.listServices();
    let target: { service: string; characteristic: string } | null = null;

    for (const svc of services) {
      // 官方会跳过短 UUID 的通用服务（0x1800 / 0x1801 之类）
      if (svc.uuid.length < 5) continue;
      for (const c of svc.characteristics) {
        const hasNotify = (c.properties & PROP_NOTIFY) !== 0;
        const hasWriteNoRsp = (c.properties & PROP_WRITE_WITHOUT_RESPONSE) !== 0;
        if (hasNotify && hasWriteNoRsp) {
          target = { service: svc.uuid, characteristic: c.uuid };
          break;
        }
      }
      if (target) break;
    }

    if (!target) {
      await conn.disconnect().catch(() => undefined);
      throw new Error("这台设备没有可用的打印通道（可能不是精臣打印机）");
    }

    this.conn = conn;
    this.charUuid = target.characteristic;
    this.serviceUuid = target.service;

    // 订阅通知：收到的字节直接喂给协议栈解析
    await conn.subscribe(target.characteristic, target.service, (data: number[]) => {
      this.processRawPacket(Uint8Array.from(data));
    });

    this.deviceName = name || addr;

    // 握手：发 Connect 包、读型号/固件版本/电量
    await this.negotiateAndGetPrinterInfo(() => {
      void this.disconnect();
    });

    const result: ConnectionInfo = {
      deviceName: this.deviceName,
      result: this.printerInfo.connectResult ?? ConnectResult.FirmwareErrors,
    };

    /* 必须发这个事件。父类构造函数里挂了 on("connect") → startHeartbeat()，
     * 不发这里心跳永远不启动，打印机闲置一会儿就休眠断连。 */
    this.emit("connect", new ConnectEvent(result));

    return result;
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeat();
    const conn = this.conn;
    this.conn = null;
    this.charUuid = null;
    if (conn) {
      await conn.disconnect().catch(() => undefined);
    }
  }

  /** 发送原始字节（协议栈上层已经把命令封装好了） */
  async sendRaw(data: Uint8Array, force?: boolean): Promise<void> {
    const doSend = async () => {
      if (!this.conn || !this.charUuid) throw new Error("打印机未连接");
      // 关键：两次写之间必须留间隔，否则打印机来不及处理会丢包
      await new Promise((r) => setTimeout(r, this.packetIntervalMs));
      await this.conn.send(
        this.charUuid,
        Array.from(data),
        "withoutResponse",
        this.serviceUuid
      );
      // 与官方一致：发完抛事件，方便调试和上层统计
      this.emit("rawpacketsent", new RawPacketSentEvent(data));
    };

    // force=true 说明调用方已经持有锁（sendPacketWaitResponse 内部就是这样），
    // 这里再抢锁会死锁，必须直接发。
    if (force) {
      await doSend();
      return;
    }
    await this.mutex.runExclusive(doSend);
  }
}
