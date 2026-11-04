/**
 * 断点常量
 * ------------------------------------------------------------------
 * 手机单栏布局的阈值必须和 styles.css 里的 @media (max-width: 860px) 一致。
 * CSS 不能 import TS，所以这里只维护 TS 侧的一份；改数值时记得同步 styles.css，
 * 否则会出现"面板已经变抽屉、内容却还按桌面顺序排"的错位。
 */
export const MOBILE_MAX_PX = 860;

/** 给 matchMedia 用的媒体查询串 */
export const MOBILE_Q = `(max-width: ${MOBILE_MAX_PX}px)`;

/** 当前是否处于手机单栏布局 */
export function isCompactLayout(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(MOBILE_Q).matches
    : false;
}
