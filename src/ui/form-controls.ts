/**
 * 表单控件小工具
 * ------------------------------------------------------------------
 * 属性面板里到处是"标签 + 输入框 + 单位"这种组合，抽成两个函数，
 * 避免每个字段各写一遍 DOM 拼装。
 */

/** label > span(标题) + 控件 + i(单位) */
export function labelWrap(text: string, node: HTMLElement, unit?: string): HTMLElement {
  const row = document.createElement("label");
  row.className = "field";
  const span = document.createElement("span");
  span.textContent = text;
  row.append(span, node);
  if (unit) {
    const u = document.createElement("i");
    u.textContent = unit;
    row.appendChild(u);
  }
  return row;
}

/** 数字输入框：input 事件里把合法数值交给 apply */
export function numInput(
  value: number,
  step: number,
  min: number,
  max: number,
  apply: (v: number) => void
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.step = String(step);
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  input.oninput = () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) apply(v);
  };
  return input;
}
