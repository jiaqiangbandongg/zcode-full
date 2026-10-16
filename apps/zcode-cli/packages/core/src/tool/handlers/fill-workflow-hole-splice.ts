// ============================================================
// FillWorkflowHole：确认窗预览用的有效脚本
// ============================================================
// docs/dynamic-workflow/launch.md「Approval」：别的会话的 run 开窗时，窗里画的是**有效脚本**的图
// （补上函数体之后的那份），而拼接与编译真正发生在端口实现侧、批准之后。所以这里在 resolveInput
// 里预先拼一次，只为让 prepareApproval 有图可画；它不是执行路径，端口侧的 `fillHole` 才是。
//
// 拼接本体是分析器包的 `spliceHoleBody`（apps/zcode-cli/packages/dynamic-workflow/docs/analysis.md
// 「Sites」）：函数体插在留白调用的闭括号前，站点 id 的编号规则由分析器保证。

import { collectSites, createWorkflowProgram, spliceHoleBody } from "@zcode/dynamic-workflow";

/**
 * 把函数体拼进 run 的脚本，返回有效脚本文本；拼不了（留白未知、已补过、脚本连站点表都建不出）时回
 * `undefined`——调用方据此开一个没有预览的窗，绝不抛。
 */
export function spliceHoleBodyPreview(
  scriptText: string,
  holeSiteId: string,
  body: string,
): string | undefined {
  try {
    const table = collectSites(createWorkflowProgram(scriptText));
    return spliceHoleBody(scriptText, table, holeSiteId, body)?.text;
  } catch {
    return undefined;
  }
}
