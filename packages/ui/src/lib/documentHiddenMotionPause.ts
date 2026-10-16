/**
 * 页面不可见时暂停 CSS 动画，spec 见 docs/performance/hidden-document-motion-pause.md。
 *
 * Bug 根因：窗口 hidden 时 Chromium 不出动画帧，CSS transition/animation 无法结算；
 * 带动画的元素此时被移除，DocumentTimeline 仍强引用它，并经 parent 指针拖住整棵已卸载的
 * 消息子树（实测 hidden 期间 GC 后 23 万 DOM 节点，恢复可见 1s 内回落到 4.5 万）。
 * 这里以 document.visibilityState 为唯一数据源给 <html> 打标记，styles.css 据此禁用动画，
 * 保证 hidden 期间不创建新的动画对象。
 */
export const DOCUMENT_HIDDEN_ATTRIBUTE = "data-document-hidden";

export function installDocumentHiddenMotionPause(doc: Document = document): () => void {
  const sync = () => {
    doc.documentElement.toggleAttribute(
      DOCUMENT_HIDDEN_ATTRIBUTE,
      doc.visibilityState === "hidden",
    );
  };
  sync();
  doc.addEventListener("visibilitychange", sync);
  return () => {
    doc.removeEventListener("visibilitychange", sync);
    doc.documentElement.removeAttribute(DOCUMENT_HIDDEN_ATTRIBUTE);
  };
}
