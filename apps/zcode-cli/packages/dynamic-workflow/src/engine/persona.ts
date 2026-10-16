// ============================================================
// actor persona 的两个纯函数：规范化（createActor）与缓存身份（matchImportedActor）
// ============================================================
// 从 engine.ts / imported-cache.ts 拆出：两者都是「persona 里哪些东西算数」的回答，住在一处才不会
// 一边加了字段、另一边忘了排除（docs/execution-engine.md「Engine-side persona」）。

import type { PersonaSpec } from "./types.js";

/**
 * persona 规范化：字符串视为 system prompt；display name 落到 persona.name。
 *
 * 对象 persona 只取认得的三个键、且只收字符串值：它来自沙箱的线上 JSON，而 persona 会原样落进
 * journal、进缓存比对与宿主的建会话路径——一个脚本经类型断言塞进来的怪值（`model: 42`、多余
 * 的键）不该一路搬下去。`model` 缺席即「跑 run 的子代理模型」。
 */
export function normalizePersona(
  name: string | undefined,
  persona: string | PersonaSpec | undefined,
): PersonaSpec {
  const base: PersonaSpec = {};
  if (typeof persona === "string") {
    base.system = persona;
  } else if (persona !== null && typeof persona === "object") {
    if (typeof persona.name === "string") base.name = persona.name;
    if (typeof persona.system === "string") base.system = persona.system;
    if (typeof persona.model === "string") base.model = persona.model;
  }
  if (base.name === undefined && name !== undefined) base.name = name;
  return base;
}

/**
 * persona 里参与缓存身份比对的部分：名字与 system prompt，**不含 `model`**
 * （docs/dynamic-workflow/authoring.md「Choosing a model per subagent」）。
 *
 * 换模型与改 persona 不是一回事：旧 system prompt 产的转录接新 persona 是身份错乱，而「这个
 * 子代理改跑另一个模型」是用户对**接下来**的工作的显式选择——与 `AmendWorkflow` 带
 * `subagent_model` 同一条规则（execution-engine.md「Subagent sessions」）：已完成的活照旧导入，
 * 下一次 live ask 跑在新模型上。把 model 算进身份，改一个裁判的模型就会让它整段重跑。
 */
export function personaIdentity(persona: PersonaSpec): PersonaSpec {
  const { model: _model, ...identity } = persona;
  void _model;
  return identity;
}
