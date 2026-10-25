/**
 * 应用入口：设备 → 排版 → 打印
 * 界面全部手写 DOM，不依赖 UI 框架；协议交给 niimbluelib，只写传输适配器。
 */
import "./styles.css";
import {
  TauriBleClient,
  scanDevices,
  looksLikeNiimbot,
  type DiscoveredDevice,
} from "./transport/blec-client";
import { printCanvas } from "./core/print-service";
import {
  deleteTemplate,
  emptyDoc,
  loadTemplates,
  saveTemplate,
  type LabelDoc,
  type PaperSetup,
  type SavedTemplate,
} from "./core/label-doc";
import { BUILTIN_PRESETS, buildPreset } from "./core/presets";
import { LabelEditor } from "./ui/editor";
import { canvasSizeOf } from "./render/render-label";
import type { LabelType } from "@mmote/niimbluelib";

/** LabelType 枚举 → 中文名（真正的白名单按机型 paperTypes 过滤） */
const LABEL_NAMES: Record<number, string> = {
  1: "间隙纸",
  2: "黑标纸",
  3: "连续纸",
  4: "打孔纸",
  5: "透明纸",
  6: "PVC 标签",
  10: "黑标间隙纸",
  11: "热缩管",
};

/**
 * 没连打印机时的默认纸张：B1 实测可打印 50mm（400 点 @203dpi）。
 * 宽 50 / 高 30 同时也是"中心对齐"的默认输入：
 * 容器 50mm、中心 X 25mm，所以宽 30 的元素落在 x=10、宽 50 的落在 x=0（见 core/align.ts）。
 */
const DEFAULT_PAPER: PaperSetup = {
  widthMm: 50,
  heightMm: 30,
  dpi: 203,
  printheadDots: 400,
};

const client = new TauriBleClient();
let devices: DiscoveredDevice[] = [];
let showAllDevices = false;
let activeAddress: string | null = null;

const app = document.querySelector<HTMLDivElement>("#app")!;

app.innerHTML = `
<header>
  <button id="btn-menu" class="icon-btn" title="设备与模板">☰</button>
  <h1>标签打印</h1>
  <span class="badge off" id="conn-badge">未连接</span>
  <span style="flex:1"></span>
  <span class="badge" id="model-badge">机型 —</span>
</header>

<div class="scrim" id="scrim"></div>

<main>
  <aside class="sidebar">
    <h2>设备</h2>
    <button id="btn-scan" style="width:100%">扫描附近打印机</button>
    <label class="check"><input type="checkbox" id="opt-all" /> 显示全部蓝牙设备</label>
    <div class="device-list" id="devices"></div>

    <h2 class="mt">打印机信息</h2>
    <table class="info">
      <tr><td>机型</td><td id="i-model">—</td></tr>
      <tr><td>固件</td><td id="i-fw">—</td></tr>
      <tr><td>硬件</td><td id="i-hw">—</td></tr>
      <tr><td>序列号</td><td id="i-sn">—</td></tr>
      <tr><td>电量</td><td id="i-bat">—</td></tr>
      <tr><td>打印宽度</td><td id="i-width">—</td></tr>
      <tr><td>分辨率</td><td id="i-dpi">—</td></tr>
    </table>

    <h2 class="mt">模板</h2>
    <select id="opt-preset" style="width:100%" title="内置模板，选中即套用"></select>
    <select id="opt-template" style="width:100%" class="mt" title="你自己保存的模板"></select>
    <div class="row-actions mt">
      <button id="btn-save">保存</button>
      <button id="btn-del">删除</button>
      <button id="btn-blank">清空</button>
    </div>

    <p class="hint mt">
      打印机同一时间只能被一台设备连接，连不上就先关掉手机上的精臣 App。
    </p>
  </aside>

  <section class="workspace">
    <div class="toolbar">
      <button data-add="text">+ 文字</button>
      <button data-add="barcode">+ 条码</button>
      <button data-add="qrcode">+ 二维码</button>
      <button data-add="rect">+ 矩形</button>
      <button data-add="line">+ 线条</button>
      <button data-add="image">+ 图片</button>
      <span style="flex:1"></span>
      <span class="hint" id="doc-size"></span>
    </div>

    <div class="toolbar">
      <label>份数</label>
      <input type="number" id="opt-qty" value="1" min="1" max="99" />
      <label>标签类型</label>
      <select id="opt-label" disabled>
        <option value="1">间隙纸</option>
      </select>
      <label>浓度</label>
      <input type="range" id="opt-density" min="1" max="5" value="3" />
      <span class="val" id="density-val">3</span>
      <span style="flex:1"></span>
      <button id="btn-print" class="primary" disabled>打印</button>
    </div>

    <div class="stage-wrap">
      <div class="stage" id="stage">
        <canvas id="preview"></canvas>
        <div class="overlay" id="overlay"></div>
      </div>
    </div>

    <div class="progress" id="progress" hidden><i></i></div>
    <div class="log" id="log">就绪</div>
  </section>

  <!--
    属性面板外面这层 .sheet 是给手机用的：桌面上 CSS 让它退化成原来的
    右栏（直接当 flex 子项），手机上它变成从底部滑出的抽屉。
    包一层而不是直接改 .inspector，是因为 #inspector 的内容由编辑器
    整块重建，放进去的关闭按钮会被冲掉。
  -->
  <div class="sheet" id="sheet">
    <div class="sheet-bar">
      <span class="sheet-grip"></span>
      <span class="sheet-title" id="sheet-title">属性</span>
      <button id="sheet-close">收起</button>
    </div>
    <aside class="inspector" id="inspector"></aside>
  </div>
</main>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const logEl = $("log");
function log(msg: string, isError = false) {
  const line = document.createElement("div");
  if (isError) line.className = "err";
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.prepend(line);
}

function setConnectedUI(on: boolean) {
  const badge = $("conn-badge");
  badge.textContent = on ? "已连接" : "未连接";
  badge.className = `badge ${on ? "on" : "off"}`;
  $<HTMLButtonElement>("btn-print").disabled = !on;
}

function setProgress(percent: number, text?: string) {
  const bar = $("progress");
  bar.hidden = percent <= 0;
  bar.querySelector("i")!.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  bar.title = text ?? `${Math.round(percent)}%`;
}

/* ---------------------------------------------------------------- 编辑器 */

function pickImageFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/bmp,image/webp";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    };
    input.click();
  });
}

/* ------------------------------------------------------ 手机端布局控制 */

/** 与 styles.css 里的断点保持一致：≤860px 走"抽屉 + 底部面板"布局 */
const MOBILE_Q = "(max-width: 860px)";
const isMobile = () => window.matchMedia(MOBILE_Q).matches;

/** 左侧「设备与模板」抽屉 */
function setDrawer(on: boolean) {
  document.body.classList.toggle("drawer-open", on);
  $("btn-menu").setAttribute("aria-expanded", String(on));
}

/** 底部属性面板 */
function setSheet(on: boolean) {
  document.body.classList.toggle("sheet-open", on);
}

function closeOverlays() {
  setDrawer(false);
  setSheet(false);
}

/** 把画布缩放到刚好铺满可用宽度（手机竖屏唯一能让元素点得着的办法） */
function fitStage() {
  if (!isMobile()) return;
  const wrap = document.querySelector<HTMLElement>(".stage-wrap");
  if (!wrap) return;
  // 减去 stage-wrap 的左右内边距，不然右边会被裁掉一点
  editor.fitToWidth(wrap.clientWidth - 24);
}

/** 纸型变过才重新适配，否则每次拖拽都会重算缩放 */
let lastPaperKey = "";

const editor = new LabelEditor({
  canvas: $<HTMLCanvasElement>("preview"),
  overlay: $("overlay"),
  inspector: $("inspector"),
  doc: buildPreset("material", { ...DEFAULT_PAPER }),
  hooks: {
    pickImage: pickImageFile,
    notify: (msg, isError) => log(msg, isError),
    onChange: (doc) => {
      const { width, height } = canvasSizeOf(doc);
      $("doc-size").textContent = `${doc.paper.widthMm}×${doc.paper.heightMm}mm · ${width}×${height}点`;
      // 换了纸张/打印头 → 手机的适配比例要重算；拖拽元素不会走到这里
      const key = `${doc.paper.widthMm}x${doc.paper.heightMm}@${doc.paper.dpi}/${doc.paper.printheadDots}`;
      if (isMobile() && key !== lastPaperKey) {
        lastPaperKey = key;
        requestAnimationFrame(fitStage);
      }
    },
    // 手机上选中元素 → 弹出属性面板；点空白 → 收起
    onSelect: (id) => {
      if (!isMobile()) return;
      setSheet(id !== null);
    },
  },
});

/* ---------------------------------------------------------------- 设备列表 */

function renderDevices() {
  const box = $("devices");
  box.textContent = "";

  const shown = showAllDevices ? devices : devices.filter((d) => looksLikeNiimbot(d.name));

  if (shown.length === 0) {
    const tip = document.createElement("div");
    tip.className = "hint";
    tip.textContent =
      devices.length === 0 ? "还没有扫描到设备" : "没识别到打印机，试试勾选上面的「显示全部」";
    box.appendChild(tip);
    return;
  }

  for (const d of shown) {
    const el = document.createElement("div");
    el.className = `device${d.address === activeAddress ? " active" : ""}`;

    const left = document.createElement("div");
    const name = document.createElement("div");
    name.className = "name";
    // 必须走 textContent：蓝牙广播名是外部可控的
    name.textContent = d.name || "未知设备";
    const addr = document.createElement("div");
    addr.className = "addr";
    addr.textContent = d.address;
    left.append(name, addr);

    const rssi = document.createElement("span");
    rssi.className = "addr";
    rssi.textContent = `${d.rssi} dBm`;

    el.append(left, rssi);
    el.onclick = () => void doConnect(d);
    box.appendChild(el);
  }
}

async function doScan() {
  const btn = $<HTMLButtonElement>("btn-scan");
  btn.disabled = true;
  btn.textContent = "扫描中…";
  try {
    await scanDevices((list) => {
      devices = list;
      renderDevices();
    }, 8000);
    log(`扫描完成，找到 ${devices.length} 台设备`);
  } catch (e) {
    log(`扫描失败：${(e as Error).message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "扫描附近打印机";
  }
}

/* ---------------------------------------------------------------- 连接 */

async function doConnect(d: DiscoveredDevice) {
  activeAddress = d.address;
  renderDevices();
  // 手机端：点了设备就把抽屉收起来，否则连接日志全被挡住
  setDrawer(false);
  log(`正在连接 ${d.name || d.address}…`);
  try {
    await client.connect(d.address, d.name);
    const info = client.getPrinterInfo();
    const meta = client.getModelMetadata();

    $("i-model").textContent = meta?.model ?? "—";
    $("i-fw").textContent = info.softwareVersion ?? "—";
    $("i-hw").textContent = info.hardwareVersion ?? "—";
    $("i-sn").textContent = info.serial ?? "—";
    $("i-bat").textContent = info.batteryPercents != null ? `${info.batteryPercents}%` : "—";
    $("i-width").textContent = meta ? `${meta.printheadPixels} 点（机型表；实际出图按纸张设置）` : "—";
    $("i-dpi").textContent = meta ? `${meta.dpi} dpi` : "—";
    $("model-badge").textContent = meta ? `${meta.model} · ${meta.dpi}dpi` : "机型 —";

    if (meta) {
      const doc = editor.getDoc();
      /* 分辨率以真机为准；打印头点数**不覆盖**用户设置。
       * 机型表里 B1 写的是 384 点（48mm），但这台机器实测打满 50mm（400 点），
       * 只有在分辨率变了（换了别的机型）时才按元数据重置。 */
      const sameDpi = doc.paper.dpi === meta.dpi;
      editor.setDoc({
        ...doc,
        paper: {
          dpi: meta.dpi,
          printheadDots: sameDpi ? doc.paper.printheadDots : meta.printheadPixels,
          widthMm: doc.paper.widthMm,
          heightMm: doc.paper.heightMm,
        },
      });
    }

    applyModelOptions();
    setConnectedUI(true);
    log("连接成功");
  } catch (e) {
    setConnectedUI(false);
    log(`连接失败：${(e as Error).message}`, true);
  }
}

/** 按机型真实能力重建"标签类型"和"浓度"，避免下发打印机不支持的值 */
function applyModelOptions() {
  const meta = client.getModelMetadata();
  const sel = $<HTMLSelectElement>("opt-label");
  sel.textContent = "";
  for (const t of meta?.paperTypes ?? [1]) {
    const o = document.createElement("option");
    o.value = String(t);
    o.textContent = LABEL_NAMES[t] ?? `类型 ${t}`;
    sel.appendChild(o);
  }
  sel.disabled = false;

  // 第三方纸没有 RFID 标签，打印结束不用再去读标签信息
  client.setFetchRfidOnPrintEnd(false);

  const dens = $<HTMLInputElement>("opt-density");
  dens.min = String(meta?.densityMin ?? 1);
  dens.max = String(meta?.densityMax ?? 5);
  dens.value = String(meta?.densityDefault ?? 3);
  $("density-val").textContent = dens.value;
}

/* ---------------------------------------------------------------- 模板 */

let templates: SavedTemplate[] = loadTemplates();

/** 内置模板下拉：第一项是占位，避免"选中即套用"在初始化时误触发 */
function renderPresets() {
  const sel = $<HTMLSelectElement>("opt-preset");
  sel.textContent = "";
  const head = document.createElement("option");
  head.value = "";
  head.textContent = "内置模板…";
  sel.appendChild(head);
  for (const p of BUILTIN_PRESETS) {
    const o = document.createElement("option");
    o.value = p.key;
    o.textContent = p.label;
    sel.appendChild(o);
  }
  sel.value = "";
}

function renderTemplates() {
  const sel = $<HTMLSelectElement>("opt-template");
  sel.textContent = "";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = templates.length === 0 ? "本地模板（空）" : "选择本地模板…";
  sel.appendChild(blank);
  for (const t of templates) {
    const o = document.createElement("option");
    o.value = t.name;
    o.textContent = t.name;
    sel.appendChild(o);
  }
}

function saveCurrent() {
  const name = window.prompt("模板名称", editor.getDoc().name || "我的标签");
  if (!name) return;
  templates = saveTemplate(name, editor.getDoc());
  renderTemplates();
  log(`已保存模板「${name}」`);
}

function loadSelected() {
  const name = $<HTMLSelectElement>("opt-template").value;
  const t = templates.find((x) => x.name === name);
  if (!t) return;
  editor.setDoc({ ...t.doc, paper: { ...t.doc.paper } });
  log(`已载入模板「${name}」`);
}

function deleteSelected() {
  const name = $<HTMLSelectElement>("opt-template").value;
  if (!name) return;
  if (!window.confirm(`删除模板「${name}」？`)) return;
  templates = deleteTemplate(name);
  renderTemplates();
  log(`已删除模板「${name}」`);
}

/* ---------------------------------------------------------------- 打印 */

async function doPrint() {
  const btn = $<HTMLButtonElement>("btn-print");
  btn.disabled = true;
  try {
    const canvas = $<HTMLCanvasElement>("preview");
    const qty = Math.max(1, Number($<HTMLInputElement>("opt-qty").value) || 1);
    const labelType = Number($<HTMLSelectElement>("opt-label").value) as LabelType;
    const density = Number($<HTMLInputElement>("opt-density").value);

    setProgress(1, "准备");
    await printCanvas(client, canvas, { density, labelType, quantity: qty }, (stage) => {
      log(`打印：${stage}`);
      if (stage === "完成") setProgress(100, "完成");
    });
    log("打印完成");
  } catch (e) {
    log(`打印失败：${(e as Error).message}`, true);
  } finally {
    btn.disabled = !client.isConnected();
    setTimeout(() => setProgress(0), 1200);
  }
}

/* ---------------------------------------------------------------- 事件 */

$("btn-scan").addEventListener("click", () => void doScan());
$("btn-save").addEventListener("click", saveCurrent);
$("btn-del").addEventListener("click", deleteSelected);
$("btn-print").addEventListener("click", () => void doPrint());

$<HTMLSelectElement>("opt-template").addEventListener("change", loadSelected);

$<HTMLSelectElement>("opt-preset").addEventListener("change", (e) => {
  const sel = e.target as HTMLSelectElement;
  const key = sel.value;
  if (!key) return;
  const label = sel.selectedOptions[0]?.textContent ?? key;
  // 纸张沿用用户当前设置，模板只负责排版，不擅自改纸
  editor.setDoc(buildPreset(key, { ...editor.getDoc().paper }));
  log(`已套用内置模板：${label}`);
  // 复位到占位项，否则再选同一个模板不会触发 change，想重套一次就没反应
  sel.value = "";
});

$("btn-blank").addEventListener("click", () => {
  editor.setDoc(emptyDoc({ ...editor.getDoc().paper }));
  log("画布已清空");
});

for (const btn of Array.from(document.querySelectorAll<HTMLElement>("[data-add]"))) {
  const kind = btn.dataset.add as "text" | "barcode" | "qrcode" | "rect" | "line" | "image";
  btn.addEventListener("click", () => editor.add(kind));
}

$<HTMLInputElement>("opt-all").addEventListener("change", (e) => {
  showAllDevices = (e.target as HTMLInputElement).checked;
  renderDevices();
});

$<HTMLInputElement>("opt-density").addEventListener("input", (e) => {
  $("density-val").textContent = (e.target as HTMLInputElement).value;
});

// 打印机被抢占或休眠时，界面要立刻反映出来
client.on("disconnect", () => {
  setConnectedUI(false);
  setProgress(0);
  log("连接已断开（被其他设备抢占，或打印机休眠）", true);
});

client.on("heartbeatfailed", (e) => {
  // 偶发丢包不算掉线，只有连续失败到一定次数才提示
  if (e.failedAttempts % 10 === 0) log(`心跳连续失败 ${e.failedAttempts} 次（不影响打印）`);
});

// 库把进度拆成"发数据"和"走纸"两个百分比，取大的那个
client.on("printprogress", (e) => {
  const p = Math.max(e.pagePrintProgress, e.pageFeedProgress);
  setProgress(p, `第 ${e.page}/${e.pagesTotal} 张 ${Math.round(p)}%`);
});

/* ------------------------------------------------------ 手机端交互绑定 */

$("btn-menu").addEventListener("click", () => {
  setDrawer(!document.body.classList.contains("drawer-open"));
});
$("scrim").addEventListener("click", closeOverlays);
$("sheet-close").addEventListener("click", () => setSheet(false));

/* 旋转屏幕 / 拉窄窗口时把两套浮层收掉，
 * 否则回到桌面宽度会残留一个"开着"的状态，下次变窄就自己蹦出来 */
const mq = window.matchMedia(MOBILE_Q);
const onBreakpointChange = () => {
  closeOverlays();
  lastPaperKey = "";
  requestAnimationFrame(fitStage);
};
if (typeof mq.addEventListener === "function") mq.addEventListener("change", onBreakpointChange);
else (mq as MediaQueryList & { addListener(f: () => void): void }).addListener(onBreakpointChange);

let resizeTimer = 0;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(fitStage, 120);
});

// 首帧：等浏览器把布局算完再拟合，否则 clientWidth 还是 0
requestAnimationFrame(() => requestAnimationFrame(fitStage));

// 触屏长按默认会弹系统的"复制/粘贴"菜单（放大镜那一套）。
// CSS 已经在触屏上关掉了文本选择，这里再兜一层，输入框除外。
window.addEventListener("contextmenu", (e) => {
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  e.preventDefault();
});

renderDevices();
renderPresets();
renderTemplates();
