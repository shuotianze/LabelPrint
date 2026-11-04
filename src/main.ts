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
  type PaperSetup,
  type SavedTemplate,
} from "./core/label-doc";
import { BUILTIN_PRESETS, buildPreset } from "./core/presets";
import { LabelEditor } from "./ui/editor";
import { MOBILE_Q, isCompactLayout } from "./ui/breakpoints";
import { canvasSizeOf, createCache, renderLabel } from "./render/render-label";
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
  <h1>标签打印</h1>
  <span class="badge off" id="conn-badge">未连接</span>
  <span style="flex:1"></span>
</header>

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

    <!--
      手机专用：模板卡片行，放在"加元素"上面——套模板是排版的第一步。
      收起时只露 4 张，点「全部」展开；当前套用的那张高亮，
      改完内容点「更新」直接覆盖当前模板，不用再输名字。
    -->
    <section class="tpl-row" id="tpl-row">
      <div class="tpl-head">
        <span class="tpl-title">模板</span>
        <span class="tpl-current" id="tpl-current">未选择</span>
        <span style="flex:1"></span>
        <button type="button" class="tpl-mini" id="tpl-update" hidden>更新</button>
        <button type="button" class="tpl-mini" id="tpl-save">存为模板</button>
        <button type="button" class="tpl-mini" id="tpl-more">全部</button>
      </div>
      <div class="tpl-cards" id="tpl-cards"></div>
    </section>

    <!--
      手机专用：预览下面这条"加元素"快捷栏。
      桌面上有两排工具栏，手机上那两排会被隐藏，只留这一条横向滑动的按钮行。
      按钮同样带 data-add，下面统一绑事件，不用第二套逻辑。
    -->
    <div class="add-bar" id="add-bar">
      <button data-add="text">+ 文字</button>
      <button data-add="barcode">+ 条码</button>
      <button data-add="qrcode">+ 二维码</button>
      <button data-add="rect">+ 矩形</button>
      <button data-add="line">+ 线条</button>
      <button data-add="image">+ 图片</button>
    </div>

    <div class="progress" id="progress" hidden><i></i></div>
    <div class="log" id="log">就绪</div>
  </section>

  <!--
    属性面板外面这层 .sheet 是给手机用的：桌面上 CSS 让它退化成原来的
    右栏（直接当 flex 子项），手机上它是常驻在底部的面板——不弹出、不收起。
    常驻而不是"选中才弹"：弹出会盖住画布，收起又看不到参数，
    而且一弹一收画布区域跟着变，想再加选第二个元素时手指落点全变了。
  -->
  <div class="sheet" id="sheet">
    <aside class="inspector" id="inspector"></aside>
  </div>
</main>

<!--
  手机专用底部区（桌面上 display: none）：
  一行是纸型/标签类型/浓度 + 设置入口，一行是份数步进器 + 打印按钮，
  最下面是"编辑 / 设备"两个标签页。整块固定贴在屏幕底部，不随内容滚动。
-->
<div class="dock" id="dock">
  <div class="dock-info">
    <span id="m-info">50×30mm</span>
    <button id="m-settings">设置</button>
  </div>
  <div class="dock-actions">
    <div class="stepper">
      <button id="m-qty-minus" aria-label="减少份数">−</button>
      <span id="m-qty">1 张</span>
      <button id="m-qty-plus" aria-label="增加份数">+</button>
    </div>
    <button id="m-print" class="primary">先连接打印机</button>
  </div>
  <nav class="tabbar">
    <button id="tab-edit" class="on">编辑</button>
    <button id="tab-device">设备</button>
  </nav>
</div>

<!--
  模板的输入框与确认面板。替代 window.prompt / confirm：
  安卓 WebView 里 prompt 经常直接返回 null，点了没反应，手机上等于存不了模板。
  桌面上是居中弹窗，手机上是从底部升起的面板。
-->
<div class="tpl-sheet" id="tpl-sheet" hidden>
  <div class="tpl-sheet-body">
    <h2 id="tpl-sheet-title">存为模板</h2>
    <input type="text" id="tpl-name" placeholder="模板名称" autocomplete="off" />
    <p class="tpl-warn" id="tpl-warn"></p>
    <div class="row-actions">
      <button type="button" id="tpl-confirm" class="primary">保存</button>
      <button type="button" id="tpl-cancel">取消</button>
    </div>
  </div>
</div>

<!-- 模板卡片右上角「⋯」弹出的操作菜单（重命名 / 复制 / 删除） -->
<div class="tpl-menu" id="tpl-menu" hidden>
  <div class="tpl-menu-body">
    <h2 id="tpl-menu-title">模板</h2>
    <button type="button" data-tpl-act="rename">重命名</button>
    <button type="button" data-tpl-act="dup">复制一份</button>
    <button type="button" data-tpl-act="del" class="danger">删除</button>
    <button type="button" data-tpl-act="close">取消</button>
  </div>
</div>

<div class="toast" id="toast" hidden></div>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const logEl = $("log");

/* 手机上日志区是藏起来的（一条条刷过去没人看），
 * 但有反馈必须给（居中到纸边、模板保存失败都在走这条路），
 * 所以窄屏改成底部一闪而过的提示条。 */
let toastTimer = 0;
function toast(msg: string, isError = false) {
  if (!isMobile()) return;
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("err", isError);
  el.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.hidden = true;
  }, 2600);
}

function log(msg: string, isError = false) {
  const line = document.createElement("div");
  if (isError) line.className = "err";
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.prepend(line);
  toast(msg, isError);
}

function setConnectedUI(on: boolean) {
  const badge = $("conn-badge");
  badge.textContent = on ? "已连接" : "未连接";
  badge.className = `badge ${on ? "on" : "off"}`;
  $<HTMLButtonElement>("btn-print").disabled = !on;
  /* 手机底部那个按钮不置灰：没连接时它变成"先连接打印机"，
   * 点一下直接跳到设备页。置灰等于告诉用户"这里没救了"。 */
  const m = $<HTMLButtonElement>("m-print");
  m.textContent = on ? "打印" : "先连接打印机";
  m.classList.toggle("primary", on);
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

/** 手机单栏布局判断，断点统一定义在 ui/breakpoints.ts */
const isMobile = () => isCompactLayout();

/**
 * 手机底部标签页：编辑 / 设备。
 * 设备页就是原来那个左栏（扫描、打印机信息、模板），
 * 在手机上是整页显示，不再是从左边滑出来的抽屉——
 * 抽屉那套在窄屏上要点击、要滑动、还会被遮罩挡住，不如直接给一个标签页。
 */
function setTab(tab: "edit" | "device") {
  document.body.classList.toggle("tab-devices", tab === "device");
  $("tab-edit").classList.toggle("on", tab === "edit");
  $("tab-device").classList.toggle("on", tab === "device");
}

/** 把画布缩放到刚好放进预览区（手机竖屏唯一能让整张标签不用滚动就看清的办法） */
function fitStage() {
  if (!isMobile()) return;
  const wrap = document.querySelector<HTMLElement>(".stage-wrap");
  if (!wrap) return;
  const cs = window.getComputedStyle(wrap);
  // clientWidth/clientHeight 含内边距，要减掉，不然右下角会被裁一点
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  editor.fitToBox(wrap.clientWidth - padX, wrap.clientHeight - padY);
}

/** 纸型变过才重新适配，否则每次拖拽都会重算缩放 */
let lastPaperKey = "";

/* 手机没有工具栏，浓度和标签类型得从「设置」里改，
 * 所以属性面板要能读写这两个控件（它们是同一份数据，不另存一套）。 */
const printAccess = {
  density: () => {
    const d = $<HTMLInputElement>("opt-density");
    return { value: Number(d.value), min: Number(d.min), max: Number(d.max) };
  },
  setDensity: (v: number) => {
    const d = $<HTMLInputElement>("opt-density");
    d.value = String(v);
    $("density-val").textContent = d.value;
    syncDock();
  },
  labelType: () => {
    const s = $<HTMLSelectElement>("opt-label");
    return {
      value: Number(s.value) || 1,
      disabled: s.disabled,
      options: Array.from(s.options).map((o) => ({
        value: Number(o.value),
        label: o.textContent ?? "",
      })),
    };
  },
  setLabelType: (v: number) => {
    $<HTMLSelectElement>("opt-label").value = String(v);
    syncDock();
  },
};

const editor = new LabelEditor({
  canvas: $<HTMLCanvasElement>("preview"),
  overlay: $("overlay"),
  inspector: $("inspector"),
  doc: buildPreset("material", { ...DEFAULT_PAPER }),
  print: printAccess,
  hooks: {
    pickImage: pickImageFile,
    notify: (msg, isError) => log(msg, isError),
    onChange: (doc) => {
      const { width, height } = canvasSizeOf(doc);
      $("doc-size").textContent = `${doc.paper.widthMm}×${doc.paper.heightMm}mm · ${width}×${height}点`;
      /* 编辑器构造末尾会先报一次 doc，那时 editor 这个常量还没赋值，
       * 所以这里把 paper 直接传进去，不走 syncDock 的默认参数。 */
      syncDock(doc.paper);
      // 换了纸张/打印头 → 手机的适配比例要重算；拖拽元素不会走到这里
      const key = `${doc.paper.widthMm}x${doc.paper.heightMm}@${doc.paper.dpi}/${doc.paper.printheadDots}`;
      if (isMobile() && key !== lastPaperKey) {
        lastPaperKey = key;
        requestAnimationFrame(fitStage);
      }
    },
  },
});

/** 手机底部信息行：纸型 · 标签类型 · 浓度，以及份数 */
function syncDock(paper = editor.getDoc().paper) {
  const labelSel = $<HTMLSelectElement>("opt-label");
  const labelName = labelSel.selectedOptions[0]?.textContent?.trim() || "间隙纸";
  const density = $<HTMLInputElement>("opt-density");
  const parts = [`${paper.widthMm}×${paper.heightMm}mm`, labelName];
  // 没连打印机时浓度还是默认值，显示出来只会让人以为能调
  if (!labelSel.disabled) parts.push(`浓度 ${density.value}`);
  $("m-info").textContent = parts.join(" · ");
  $("m-qty").textContent = `${$<HTMLInputElement>("opt-qty").value} 张`;
}

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
    heartbeatWarned = false;
    log("连接成功");
    // 手机连上之后直接回到编辑页，省得手动再点一下标签
    if (isMobile()) setTab("edit");
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

  /* 属性面板里的「标签类型 / 浓度」读的是上面这两个控件，
   * 机型变了以后选项得跟着换，否则面板里还是旧机型的可选项。 */
  editor.refreshPanel();
  syncDock();
}

/* ---------------------------------------------------------------- 模板 */

let templates: SavedTemplate[] = loadTemplates();

/** 当前套用的模板。内置按 key，自己的按名字；用来高亮卡片、显示"当前"、一键更新 */
type TplRef = { kind: "builtin"; key: string } | { kind: "local"; name: string };
let currentTpl: TplRef | null = null;

/** 最近用过的模板名，存在本地，用来把常用的排到最前面 */
const RECENT_KEY = "labelprint:tpl-recent";
let recentNames: string[] = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
})();

function markRecent(name: string) {
  recentNames = [name, ...recentNames.filter((n) => n !== name)].slice(0, 20);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentNames));
  } catch {
    /* 存不下就算了，只影响排序 */
  }
}

/** 自己的模板排序：最近用过的在前，其余按保存时间倒序 */
function orderedLocal(): SavedTemplate[] {
  const rank = (t: SavedTemplate) => {
    const i = recentNames.indexOf(t.name);
    return i < 0 ? 999 : i;
  };
  return [...templates].sort((a, b) => rank(a) - rank(b) || b.savedAt - a.savedAt);
}

/** 缩略图缓存：重绘一次就够，来回切换模板不用重画 */
const thumbCache = new Map<string, string>();
/** 缩略图排队：一次只画一张。手机上同时画十几张 1200×720 的画布会直接吃掉几十兆内存 */
let thumbQueue: Promise<unknown> = Promise.resolve();

/**
 * 把模板渲成一张小图当缩略图。
 * 用真正的 renderLabel 画，缩略图和打印内容一定是一致的；
 * 2 倍像素再缩，避免小图上条码/文字糊成一团。
 */
async function thumbOf(key: string, doc: SavedTemplate["doc"]): Promise<string> {
  const hit = thumbCache.get(key);
  if (hit) return hit;
  const job = thumbQueue.then(async () => {
    const again = thumbCache.get(key);
    if (again) return again;
    const { width, height } = canvasSizeOf(doc);
    const canvas = document.createElement("canvas");
    await renderLabel(canvas, doc, createCache());
    const small = document.createElement("canvas");
    small.width = 128;
    small.height = Math.max(1, Math.round((128 * height) / Math.max(1, width)));
    const ctx = small.getContext("2d");
    if (ctx) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(canvas, 0, 0, small.width, small.height);
    }
    const url = small.toDataURL("image/png");
    thumbCache.set(key, url);
    return url;
  });
  thumbQueue = job.catch(() => "");
  return job;
}

/** 一张卡片：local / builtin 带缩略图，add 是"存为模板"占位 */
function makeCard(
  kind: "local" | "builtin" | "add",
  id: string,
  name: string,
  meta: string,
  doc?: SavedTemplate["doc"]
): HTMLElement {
  const card = document.createElement("div");
  card.className = `tpl-card${kind === "add" ? " add" : ""}`;
  card.dataset.kind = kind;
  card.dataset.id = id;
  card.title = name;
  if (kind === "add") {
    card.textContent = "＋";
    return card;
  }

  const img = document.createElement("img");
  img.className = "tpl-thumb";
  img.alt = "";
  card.appendChild(img);

  const label = document.createElement("span");
  label.className = "tpl-name";
  label.textContent = name;
  card.appendChild(label);

  if (meta) {
    const m = document.createElement("span");
    m.className = "tpl-meta";
    m.textContent = meta;
    card.appendChild(m);
  }

  if (kind === "local") {
    const keb = document.createElement("button");
    keb.type = "button";
    keb.className = "tpl-kebab";
    keb.textContent = "⋯";
    keb.dataset.tplMenu = id;
    keb.setAttribute("aria-label", "模板操作");
    card.appendChild(keb);
  }

  if (doc) {
    void thumbOf(`${kind}:${id}`, doc).then((url) => {
      img.src = url;
    });
  }
  return card;
}

/** 手机编辑页的模板卡片行 */
function renderTemplateCards() {
  const box = $("tpl-cards");
  box.textContent = "";

  for (const t of orderedLocal()) {
    box.appendChild(
      makeCard("local", t.name, t.name, `${t.doc.paper.widthMm}×${t.doc.paper.heightMm}`, t.doc)
    );
  }
  for (const p of BUILTIN_PRESETS) {
    box.appendChild(makeCard("builtin", p.key, p.label, "", buildPreset(p.key, { ...DEFAULT_PAPER })));
  }
  box.appendChild(makeCard("add", "", "存为模板", ""));

  updateTplHead();
}

/** 顶部的"当前模板"文字、更新按钮、卡片高亮，以及桌面下拉的选中项 */
function updateTplHead() {
  const cur = $("tpl-current");
  const upd = $<HTMLButtonElement>("tpl-update");
  if (!currentTpl) {
    cur.textContent = "未选择";
    upd.hidden = true;
  } else if (currentTpl.kind === "builtin") {
    const key = currentTpl.key;
    const label = BUILTIN_PRESETS.find((p) => p.key === key)?.label ?? key;
    cur.textContent = `内置：${label}`;
    upd.hidden = true;
  } else {
    cur.textContent = `我的：${currentTpl.name}`;
    upd.hidden = false;
  }

  const onKey =
    !currentTpl
      ? ""
      : currentTpl.kind === "builtin"
        ? `builtin:${currentTpl.key}`
        : `local:${currentTpl.name}`;
  for (const card of Array.from(document.querySelectorAll<HTMLElement>("#tpl-cards .tpl-card"))) {
    card.classList.toggle("on", !!onKey && `${card.dataset.kind}:${card.dataset.id}` === onKey);
  }
  $<HTMLSelectElement>("opt-template").value =
    currentTpl?.kind === "local" ? currentTpl.name : "";
}

function applyBuiltin(key: string) {
  const p = BUILTIN_PRESETS.find((x) => x.key === key);
  // 纸张沿用用户当前设置，模板只负责排版，不擅自改纸
  const paper = { ...editor.getDoc().paper };
  editor.setDoc(buildPreset(key, paper));
  currentTpl = { kind: "builtin", key };
  renderTemplateCards();
  log(`已套用内置模板：${p?.label ?? key}（纸张保持 ${paper.widthMm}×${paper.heightMm}mm）`);
}

function applyLocal(name: string, quiet = false) {
  const t = templates.find((x) => x.name === name);
  if (!t) return;
  // 自己的模板连纸张一起恢复，卡片上标了纸型，套用后纸型跟着变
  editor.setDoc({ ...t.doc, paper: { ...t.doc.paper } });
  currentTpl = { kind: "local", name };
  markRecent(name);
  renderTemplateCards();
  if (!quiet) log(`已载入模板「${name}」（${t.doc.paper.widthMm}×${t.doc.paper.heightMm}mm）`);
}

/* ---- 保存 / 重命名的输入面板（替代 window.prompt） ---- */

type SheetMode = { kind: "save" } | { kind: "rename"; from: string };
let sheetMode: SheetMode | null = null;

function refreshSheetState() {
  const name = $<HTMLInputElement>("tpl-name").value.trim();
  const warn = $("tpl-warn");
  const confirm = $<HTMLButtonElement>("tpl-confirm");
  if (!sheetMode) return;
  if (sheetMode.kind === "rename" && name === sheetMode.from) {
    warn.textContent = "";
    confirm.textContent = "保存";
    return;
  }
  const exists = templates.some((t) => t.name === name);
  confirm.textContent = exists ? "覆盖" : "保存";
  warn.textContent = exists ? `已有同名模板「${name}」，保存会覆盖它` : "";
}

function openSheet(mode: SheetMode) {
  sheetMode = mode;
  const title = $("tpl-sheet-title");
  const input = $<HTMLInputElement>("tpl-name");
  title.textContent = mode.kind === "save" ? "存为模板" : "重命名模板";
  input.value =
    mode.kind === "save"
      ? currentTpl?.kind === "local"
        ? currentTpl.name
        : (editor.getDoc().name || "我的标签")
      : mode.from;
  $("tpl-sheet").hidden = false;
  refreshSheetState();
  input.focus();
  input.select();
}

function closeSheet() {
  sheetMode = null;
  $("tpl-sheet").hidden = true;
}

/** 存下当前画布内容。名字已存在就是覆盖，保存后当前模板跟着指向它 */
function commitSheet() {
  if (!sheetMode) return;
  const name = $<HTMLInputElement>("tpl-name").value.trim();
  if (!name) {
    $("tpl-warn").textContent = "名字不能为空";
    return;
  }
  if (sheetMode.kind === "rename") {
    const from = sheetMode.from;
    const t = templates.find((x) => x.name === from);
    if (!t) return closeSheet();
    if (name !== from) {
      if (templates.some((x) => x.name === name)) {
        $("tpl-warn").textContent = `已有同名模板「${name}」，换个名字吧`;
        return;
      }
      const res = saveTemplate(name, { ...t.doc, name });
      if (!res.ok) {
        $("tpl-warn").textContent = res.error ?? "保存失败";
        return;
      }
      deleteTemplate(from);
      templates = res.templates;
      thumbCache.delete(`local:${from}`);
      thumbCache.delete(`local:${name}`);
      if (currentTpl?.kind === "local" && currentTpl.name === from) {
        currentTpl = { kind: "local", name };
        markRecent(name);
      }
      log(`模板已重命名：${from} → ${name}`);
    }
  } else {
    const res = saveTemplate(name, editor.getDoc());
    if (!res.ok) {
      $("tpl-warn").textContent = res.error ?? "保存失败";
      return;
    }
    templates = res.templates;
    thumbCache.delete(`local:${name}`);
    currentTpl = { kind: "local", name };
    markRecent(name);
    // 超出上限会丢最旧的一份，必须让用户知道，否则下次打开就"莫名少了模板"
    log(
      res.dropped
        ? `已保存模板「${name}」，超过 ${res.templates.length} 份上限，最旧的一份已被替换`
        : `已保存模板「${name}」`
    );
  }
  closeSheet();
  renderTemplates();
  renderTemplateCards();
  syncDock();
}

/* ---- 卡片上的操作（重命名 / 复制 / 删除） ---- */

let menuName = "";
let pendingDelete = "";

function openTplMenu(name: string) {
  menuName = name;
  pendingDelete = "";
  $("tpl-menu-title").textContent = name;
  refreshMenuButtons();
  $("tpl-menu").hidden = false;
}

function refreshMenuButtons() {
  const del = document.querySelector<HTMLButtonElement>('#tpl-menu [data-tpl-act="del"]');
  if (del) {
    del.textContent = pendingDelete ? `确认删除「${pendingDelete}」` : "删除";
    del.classList.toggle("danger", true);
  }
}

function closeTplMenu() {
  menuName = "";
  pendingDelete = "";
  $("tpl-menu").hidden = true;
}

function copyTemplate(name: string) {
  const t = templates.find((x) => x.name === name);
  if (!t) return;
  const base = `${name} 副本`;
  let n = base;
  let i = 2;
  while (templates.some((x) => x.name === n)) n = `${base} ${i++}`;
  const res = saveTemplate(n, t.doc);
  if (!res.ok) {
    log(`复制失败：${res.error}`, true);
    return;
  }
  templates = res.templates;
  renderTemplates();
  renderTemplateCards();
  log(`已复制为「${n}」`);
}

function removeTemplate(name: string) {
  templates = deleteTemplate(name);
  thumbCache.delete(`local:${name}`);
  recentNames = recentNames.filter((n) => n !== name);
  if (currentTpl?.kind === "local" && currentTpl.name === name) currentTpl = null;
  renderTemplates();
  renderTemplateCards();
  log(`已删除模板「${name}」`);
}

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
  for (const t of orderedLocal()) {
    const o = document.createElement("option");
    o.value = t.name;
    o.textContent = `${t.name}（${t.doc.paper.widthMm}×${t.doc.paper.heightMm}）`;
    sel.appendChild(o);
  }
}

function saveCurrent() {
  openSheet({ kind: "save" });
}

function loadSelected() {
  const name = $<HTMLSelectElement>("opt-template").value;
  if (!name) return;
  applyLocal(name);
}

function deleteSelected() {
  const name = $<HTMLSelectElement>("opt-template").value;
  if (!name) return;
  if (!window.confirm(`删除模板「${name}」？`)) return;
  removeTemplate(name);
}

/* ---------------------------------------------------------------- 打印 */

async function doPrint() {
  const btn = $<HTMLButtonElement>("btn-print");
  btn.disabled = true;
  try {
    const qtyInput = $<HTMLInputElement>("opt-qty");
    /* 份数夹到 1~99：协议里份数是单字节，超过 99 会被截断成别的张数，
     * 用户填 200 结果只出 72 张，比直接拒绝更糟。 */
    const qty = Math.min(99, Math.max(1, Number(qtyInput.value) || 1));
    qtyInput.value = String(qty);
    const labelType = Number($<HTMLSelectElement>("opt-label").value) as LabelType;
    const density = Number($<HTMLInputElement>("opt-density").value);

    /* 打印不用屏幕上的预览画布，而是按文档重新画一张真尺寸离屏画布。
     * 预览那张的尺寸/缩放是给眼睛看的，直接拿去打印等于把"显示"
     * 当成"内容"，改过缩放的机器上会打出错误尺寸。 */
    const canvas = document.createElement("canvas");
    await renderLabel(canvas, editor.getDoc(), createCache());

    setProgress(1, "准备");
    await printCanvas(client, canvas, { density, labelType, quantity: qty }, (stage) => {
      log(`打印：${stage}`);
      if (stage === "完成") setProgress(100, "完成");
    });
    log(`打印完成（${qty} 张）`);
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
  applyBuiltin(key);
  // 复位到占位项，否则再选同一个模板不会触发 change，想重套一次就没反应
  sel.value = "";
});

/* ---- 手机模板卡片行 ---- */

// 点卡片套用；点右上角「⋯」开菜单（不套用）
$("tpl-cards").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const keb = t.closest<HTMLElement>("[data-tpl-menu]");
  if (keb) {
    e.stopPropagation();
    openTplMenu(keb.dataset.tplMenu ?? "");
    return;
  }
  const card = t.closest<HTMLElement>(".tpl-card");
  if (!card) return;
  const kind = card.dataset.kind;
  if (kind === "add") {
    openSheet({ kind: "save" });
    return;
  }
  if (kind === "builtin") applyBuiltin(card.dataset.id ?? "");
  else if (kind === "local") applyLocal(card.dataset.id ?? "");
});

$("tpl-save").addEventListener("click", saveCurrent);

$("tpl-update").addEventListener("click", () => {
  if (!currentTpl || currentTpl.kind !== "local") return;
  const res = saveTemplate(currentTpl.name, editor.getDoc());
  if (!res.ok) {
    log(`更新失败：${res.error}`, true);
    return;
  }
  templates = res.templates;
  thumbCache.delete(`local:${currentTpl.name}`);
  markRecent(currentTpl.name);
  renderTemplates();
  renderTemplateCards();
  log(`已更新模板「${currentTpl.name}」`);
});

$("tpl-more").addEventListener("click", () => {
  const row = $("tpl-row");
  const expanded = row.classList.toggle("expanded");
  $("tpl-more").textContent = expanded ? "收起" : "全部";
});

/* ---- 保存 / 重命名面板 ---- */

$("tpl-cancel").addEventListener("click", closeSheet);
$("tpl-confirm").addEventListener("click", commitSheet);
$("tpl-name").addEventListener("input", refreshSheetState);
$("tpl-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") commitSheet();
  if (e.key === "Escape") closeSheet();
});
$("tpl-sheet").addEventListener("pointerdown", (e) => {
  // 点遮罩空白处关闭，点面板本体不关
  if (e.target === $("tpl-sheet")) closeSheet();
});

/* ---- 模板操作菜单 ---- */

$("tpl-menu").addEventListener("pointerdown", (e) => {
  if (e.target === $("tpl-menu")) closeTplMenu();
});
$("tpl-menu").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-tpl-act]");
  const act = btn?.dataset.tplAct;
  if (!act) return;
  const name = menuName;
  if (act === "close" || !name) {
    closeTplMenu();
    return;
  }
  if (act === "rename") {
    closeTplMenu();
    openSheet({ kind: "rename", from: name });
    return;
  }
  if (act === "dup") {
    closeTplMenu();
    copyTemplate(name);
    return;
  }
  if (act === "del") {
    // 第一次点只是变成"确认删除"，第二次才真删——手机上不弹系统确认框
    if (pendingDelete !== name) {
      pendingDelete = name;
      refreshMenuButtons();
      return;
    }
    closeTplMenu();
    removeTemplate(name);
  }
});

$("btn-blank").addEventListener("click", () => {
  editor.setDoc(emptyDoc({ ...editor.getDoc().paper }));
  currentTpl = null;
  renderTemplateCards();
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
  syncDock();
});

// 标签类型换了下方的信息行要跟着变
$<HTMLSelectElement>("opt-label").addEventListener("change", () => syncDock());

// 打印机被抢占或休眠时，界面要立刻反映出来
client.on("disconnect", () => {
  setConnectedUI(false);
  setProgress(0);
  log("连接已断开（被其他设备抢占，或打印机休眠）", true);
});

/* 心跳连续失败说明链路已经不健康。原来只在 100000 量级才提示，
 * 实际用户看到的是"点打印没反应"，所以这里把阈值降到 30 次（约 1 分钟）
 * 并明确建议重连。每次成功连接后重置。 */
let heartbeatWarned = false;
client.on("heartbeatfailed", (e) => {
  // 偶发丢包不算掉线
  if (e.failedAttempts % 10 === 0) log(`心跳连续失败 ${e.failedAttempts} 次`);
  if (e.failedAttempts >= 30 && !heartbeatWarned) {
    heartbeatWarned = true;
    log("打印机已连续 1 分钟无响应，请断开后重新连接再打印", true);
  }
});

// 库把进度拆成"发数据"和"走纸"两个百分比，取大的那个
client.on("printprogress", (e) => {
  const p = Math.max(e.pagePrintProgress, e.pageFeedProgress);
  setProgress(p, `第 ${e.page}/${e.pagesTotal} 张 ${Math.round(p)}%`);
});

/* ------------------------------------------------------ 手机端交互绑定 */

/* 底部标签页：编辑 ↔ 设备 */
$("tab-edit").addEventListener("click", () => setTab("edit"));
$("tab-device").addEventListener("click", () => setTab("device"));

/* 点顶部连接状态：手机上直接跳到设备页，不用再去找底部标签 */
$("conn-badge").addEventListener("click", () => {
  if (isMobile()) setTab("device");
});

/* 份数步进器：直接读写隐藏的 #opt-qty，和工具栏共用同一份数据 */
function stepQty(delta: number) {
  const input = $<HTMLInputElement>("opt-qty");
  const v = Math.min(99, Math.max(1, (Number(input.value) || 1) + delta));
  input.value = String(v);
  syncDock();
}
$("m-qty-minus").addEventListener("click", () => stepQty(-1));
$("m-qty-plus").addEventListener("click", () => stepQty(1));
$("opt-qty").addEventListener("input", () => syncDock());

/* 设置：把页面滚到纸张/打印设置那一块（属性区一直显示在页面里，不用弹面板） */
$("m-settings").addEventListener("click", () => {
  document.querySelector(".paper-panel")?.scrollIntoView({ block: "center", behavior: "smooth" });
});

/* 打印按钮：没连接时变成"先连接打印机"，点它去设备页而不是干等着 */
$("m-print").addEventListener("click", () => {
  if (!client.isConnected()) {
    setTab("device");
    return;
  }
  void doPrint();
});

/* 旋转屏幕 / 拉窄窗口时回到编辑页并重新拟合画布，
 * 否则回到桌面宽度会残留"停在设备页"的状态，下次变窄就自己蹦出来 */
const mq = window.matchMedia(MOBILE_Q);
const onBreakpointChange = () => {
  setTab("edit");
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
renderTemplateCards();
syncDock();
setConnectedUI(false);
