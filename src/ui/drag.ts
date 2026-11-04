/**
 * 拖拽与缩放
 * ------------------------------------------------------------------
 * 元素框的命中、拖动、右下角手柄缩放都写在这里，不和编辑器状态耦合：
 * 需要什么就从 DragHost 取，避免 editor.ts 继续膨胀。
 */
import { MIN_WIDTH_MM, centerOf, containerOf, placeByCenter } from "../core/align";
import { round1 } from "../core/units";
import type { LabelDoc, LabelElement } from "../core/label-doc";

export interface DragHost {
  /** 当前 mm → px 的比例（每次按下时取一次，缩放后自动生效） */
  ppm(): number;
  paper(): LabelDoc["paper"];
  find(id: string): LabelElement | undefined;
  /** additive=true 时是加选/减选（Shift/Ctrl 点按） */
  select(id: string, additive?: boolean): void;
  /** 这个元素当前是否在选中集合里（触摸拖动整组时要判断） */
  isSelected(id: string): boolean;
  commit(): void;
  /** 把元素夹回纸内 */
  clampToPaper(el: LabelElement): void;
  /** 这次拖动要一起移动的元素：多选时是整组，单选时就是它自己 */
  dragTargets(id: string): LabelElement[];
  /** 双击元素（文字就地编辑，其它元素跳到属性面板） */
  onDoubleClick(id: string): void;
}

/** 上一次轻点的元素、位置与时间，用来在触摸屏上识别"双击" */
let lastTapAt = 0;
let lastTapX = 0;
let lastTapY = 0;
let lastTapId = "";

/* 只有 touch / pen 才走触摸手势。
 * 用"不等于 mouse"会把合成指针事件（pointerType 为空串）误判成触摸，
 * 桌面/自动化环境里按下就不再立即选中，行为会变得很怪。 */
const isTouchPointer = (e: PointerEvent) => e.pointerType === "touch" || e.pointerType === "pen";

/** 绑定元素框：单击选中 + 拖动移位 + 双击编辑内容 */
export function bindBoxDrag(box: HTMLElement, id: string, host: DragHost): void {
  box.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    const isTouch = isTouchPointer(e);

    /* 鼠标：按下即选中（Shift/Ctrl 加选）。
     * 触摸：按下先不选，等判定——
     *   拖动 → 选中它（没选中的话）；轻点 → 加入选中集合；长按 → 加选/减选。
     * 如果按下就先选，长按再加选会把刚选中的自己又取消掉（集合里原本只有它）。 */
    if (!isTouch) {
      host.select(id, e.shiftKey || e.ctrlKey || e.metaKey);
    }

    /* 选中后再取"要一起动的元素"：加选后是整组，单选时只有它自己。
     * 先把各自的起点存下来，拖动时用绝对位移算，避免累加误差。 */
    const targets = host.dragTargets(id).map((el) => ({ el, x: el.x, y: el.y }));
    if (!targets.length) return;

    const ppm = host.ppm();
    const startX = e.clientX;
    const startY = e.clientY;

    /* 触摸屏没有 Shift 键，也没有可靠的 dblclick：
     *   轻点 = 加选（点一个选一个，再点另一个就有两个）
     *   长按 500ms = 加选/减选（点错了可以长按取消这一个）
     *   300ms 内连点同一个元素两下 = 编辑内容（代替双击）
     * 手指一移动就取消这两个手势，避免和拖拽互相打断。 */
    let moved = false;
    let longPressed = false;
    let pressTimer: ReturnType<typeof setTimeout> | null = null;
    const clearPressTimer = () => {
      if (pressTimer !== null) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };
    if (isTouch) {
      pressTimer = setTimeout(() => {
        if (moved) return;
        longPressed = true;
        host.select(id, true);
        // 轻微震动给个反馈；不支持 vibrate 的环境会静默失败
        try {
          navigator.vibrate?.(15);
        } catch {
          /* ignore */
        }
      }, 500);
    }

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
      // 6px 以内算"手抖"，不算拖动；超过就取消长按与连点识别
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6) {
        moved = true;
        clearPressTimer();
        /* 触摸拖一个没选中的元素：这时才把它选上。用加选而不是单选——
         * 真机上"轻点"常带几像素抖动，走的就是这条拖动分支；
         * 单选会把刚点好的前一个元素踢掉，用户永远凑不出多选。 */
        if (isTouch && !host.isSelected(id)) host.select(id, true);
      }
      const dx = (ev.clientX - startX) / ppm;
      const dy = (ev.clientY - startY) / ppm;
      for (const t of targets) {
        // 吸附到 0.1mm，避免存进模板里一堆 12.837461 这种数
        t.el.x = round1(t.x + dx);
        t.el.y = round1(t.y + dy);
        host.clampToPaper(t.el);
      }
      host.commit();
    };
    const detach = () => {
      box.removeEventListener("pointermove", onMove);
      box.removeEventListener("pointerup", onUp);
      box.removeEventListener("pointercancel", onCancel);
    };
    const onUp = (ev: PointerEvent) => {
      detach();
      clearPressTimer();

      if (longPressed || moved || !isTouch) return;
      // 连点同一个元素两下 = 编辑内容（两次轻点在 320ms、30px 以内，且是同一个元素）
      const now = performance.now();
      const isDouble =
        lastTapId === id &&
        now - lastTapAt < 320 &&
        Math.hypot(ev.clientX - lastTapX, ev.clientY - lastTapY) < 30;
      lastTapAt = isDouble ? 0 : now;
      lastTapX = ev.clientX;
      lastTapY = ev.clientY;
      lastTapId = isDouble ? "" : id;

      if (isDouble) {
        // 双击进来时只保证"选中"，不要再 toggle 一次把它取消掉
        if (!host.isSelected(id)) host.select(id, true);
        host.onDoubleClick(id);
        return;
      }
      /* 轻点 = 切换选中：没选中的加进来，已经选中的再点一下就取消。
       * 手机上凑多选就靠这个——点第一个选中、点第二个也选中（不需要 Shift），
       * 想去掉其中一个就再点它一次；想全取消就点画布空白处。 */
      host.select(id, true);
    };
    const onCancel = () => {
      detach();
      clearPressTimer();
      /* 触摸手势被系统判成滚动而取消时，仍然把元素加入选中。
       * 否则手机上"点一下没反应、属性面板永远不弹出来"。 */
      if (isTouch && !moved && !longPressed && !host.isSelected(id)) host.select(id, true);
    };
    box.addEventListener("pointermove", onMove);
    box.addEventListener("pointerup", onUp);
    box.addEventListener("pointercancel", onCancel);
  });

  /* 鼠标双击：选中 + 进入内容编辑。
   * 触屏走上面的"两次轻点"识别（touch 的 dblclick 在部分 WebView 里不派发）。 */
  box.addEventListener("dblclick", () => {
    // 双击时别清空已有的多选（手机上双击常常和"两次轻点"重叠触发）
    if (!host.isSelected(id)) host.select(id, true);
    // select() 可能重建属性面板，等这一帧挂上 DOM 再操作
    requestAnimationFrame(() => host.onDoubleClick(id));
  });
}

/** 绑定右下角手柄：左右对称缩放，中心 X 不动 */
export function bindGripDrag(grip: HTMLElement, id: string, host: DragHost): void {
  grip.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    const el = host.find(id);
    if (!el) return;

    const ppm = host.ppm();
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
      const box = containerOf(host.paper());
      /* 手柄在右边，鼠标右移 dx 时右边 +dx、左边 -dx，
       * 所以宽度变化是 2 倍 dx——这样手柄始终跟着指针，中心不动。 */
      const nextW = Math.min(
        box,
        Math.max(MIN_WIDTH_MM, round1(ow + ((ev.clientX - startX) / ppm) * 2))
      );
      placeByCenter(el, { widthMm: nextW, centerMm: centerX, containerMm: box });
      el.h = Math.max(1, round1(oh + (ev.clientY - startY) / ppm));
      host.commit();
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
