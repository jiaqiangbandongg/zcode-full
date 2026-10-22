import assert from "node:assert/strict";

/** CDP 固定伪类验证级联组合；不把后台窗口的焦点当作真实键盘验收。 */
export async function checkControlStates(
  read: (code: string) => Promise<any>,
  send: (method: string, params?: any) => Promise<any>,
  standalone = false,
) {
  await read(`(() => {
    const probe=document.createElement('div');probe.id='control-state-probe';
    probe.innerHTML='<style>#control-state-probe *{transition:none}</style><label class="form-check"><input type="checkbox" class="form-check-input"></label><input class="form-control"><select class="form-select"><option>Option</option></select>';
    document.body.append(probe);probe.querySelector('[type=checkbox]').indeterminate=true;
  })()`);
  try {
    for (const selector of ["[type=checkbox]", ".form-control", ".form-select"]) {
      const { searchId } = await send("DOM.performSearch", {
        query: "#control-state-probe " + selector,
      });
      const { nodeIds } = await send("DOM.getSearchResults", {
        searchId,
        fromIndex: 0,
        toIndex: 1,
      });
      const nodeId = nodeIds[0];
      await send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
      const hover = await read(`(() => {
        const node=document.querySelector('#control-state-probe ${selector}'),css=getComputedStyle(node);
        const sample=document.createElement('span');sample.style.color='var(--primary)';document.body.append(sample);
        const primary=getComputedStyle(sample).color;sample.remove();
        return {background:css.backgroundColor,border:css.borderColor,mark:getComputedStyle(node,'::before').backgroundColor,primary};
      })()`);
      if (selector === "[type=checkbox]") {
        assert.equal(hover.background, hover.primary);
        assert.notEqual(hover.background, hover.mark);
      } else if (standalone) {
        await send("CSS.forcePseudoState", {
          nodeId,
          forcedPseudoClasses: ["focus", "focus-visible"],
        });
        const focus = await read(
          `(() => {const css=getComputedStyle(document.querySelector('#control-state-probe ${selector}'));return css.borderColor})()`,
        );
        assert.notEqual(focus, hover.border);
      }
      await send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
    }
  } finally {
    await read("document.querySelector('#control-state-probe').remove()");
  }
}
