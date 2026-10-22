import assert from "node:assert/strict";

/** 用真实文字 Range 检查字号变化后的边界，避免只验证 min-height。 */
export async function checkCompactButtons(
  read: (code: string) => Promise<any>,
  send: (method: string, params?: any) => Promise<any>,
) {
  const buttons = await read(`(() => {
    const probe=document.createElement('div');
    probe.id='compact-probe';probe.style.cssText='display:flex;gap:8px;align-items:flex-start';
    probe.innerHTML='<button class="btn btn-xs">Small 小</button><button class="btn btn-sm">Medium 中</button><button class="btn btn-lg">Large 大</button>';
    document.body.append(probe);
    const result=[...probe.children].map(button=>{
      const range=document.createRange();range.selectNodeContents(button);
      const text=range.getBoundingClientRect(),box=button.getBoundingClientRect(),css=getComputedStyle(button);
      return {top:text.top-box.top,bottom:box.bottom-text.bottom,left:box.left,right:box.right,
        line:parseFloat(css.lineHeight),inner:button.clientHeight-parseFloat(css.paddingTop)-parseFloat(css.paddingBottom)};
    });return result;
  })()`);
  try {
    for (const variant of ["btn-xs", "btn-sm", "btn-lg"]) {
      const { searchId, resultCount } = await send("DOM.performSearch", {
        query: "#compact-probe ." + variant,
      });
      assert.equal(resultCount, 1);
      const { nodeIds } = await send("DOM.getSearchResults", {
        searchId,
        fromIndex: 0,
        toIndex: 1,
      });
      const nodeId = nodeIds[0];
      await send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["focus-visible"] });
      const outline = await read(
        `(() => {const css=getComputedStyle(document.querySelector("#compact-probe .${variant}"));return [css.outlineWidth,css.outlineStyle,css.outlineOffset]})()`,
      );
      assert.deepEqual(outline, ["2px", "solid", "2px"]);
      await send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
    }
    for (const button of buttons) {
      assert.ok(button.top >= 0 && button.bottom >= 0, JSON.stringify(button));
      assert.ok(button.line <= button.inner, JSON.stringify(button));
    }
    for (let i = 1; i < buttons.length; i++)
      assert.ok(buttons[i].left - buttons[i - 1].right >= 7.5);
  } finally {
    await read("document.querySelector('#compact-probe').remove()");
  }
}
