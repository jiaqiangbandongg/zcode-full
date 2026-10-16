// 回放夹具录制时使用的上游模型，是 E2E 供应商模型的唯一默认来源。
// 供应商地址、API key 与模型名由环境变量控制：E2E_PROVIDER_BASE_URL、E2E_PROVIDER_API_KEY、
// E2E_PROVIDER_MODEL、E2E_PROVIDER_SECONDARY_MODEL（模型只在 capture 模式生效）；回放始终使用下面的录制值。
// 产品内置模型规则按模型 ID 匹配思考档位与请求形态，夹具按这两个模型录制，更换默认值需要重新录制夹具。
export const RECORDED_UPSTREAM_MODEL = "deepseek-v4-flash";
export const RECORDED_UPSTREAM_SECONDARY_MODEL = "deepseek-v4-pro";

export function resolveUpstreamModels(env: NodeJS.ProcessEnv = process.env) {
  // 修复：回放必须使用录制夹具时的模型。开发者为抓包在本地配置的 E2E_PROVIDER_MODEL 若也作用于回放，
  // 请求里的模型 ID 就对不上夹具；模型环境变量只在 capture 模式生效。
  const capture = env.E2E_PROVIDER_HTTP_MODE?.trim() === "capture";
  return {
    model: (capture && env.E2E_PROVIDER_MODEL?.trim()) || RECORDED_UPSTREAM_MODEL,
    secondaryModel:
      (capture && env.E2E_PROVIDER_SECONDARY_MODEL?.trim()) || RECORDED_UPSTREAM_SECONDARY_MODEL,
  };
}
