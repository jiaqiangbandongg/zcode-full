// 一次性改名清单：选择器必须精确匹配 Built-in 原规则，不按模型名猜测。
export const legacyReasoningLevelRenames = [
  {
    modelMatch: ".*glm-5(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*glm-5.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*GLM-5\\.2(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*GLM-5\\.2.*",
    oldLevel: "nothink",
  },
  {
    modelMatch: ".*GLM-5-Turbo(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*GLM-5-Turbo.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-5\\.1(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*glm-5\\.1.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-5\\.1-highspeed(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*glm-5\\.1-highspeed.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-5v-turbo(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*glm-5v-turbo.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-4\\.7(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*glm-4\\.7.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-4\\.7-flashx(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*glm-4\\.7-flashx.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-4\\.7-flash(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*glm-4\\.7-flash.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-4\\.6(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*glm-4\\.6.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-4\\.5(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*glm-4\\.5.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-4\\.5-air(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*glm-4\\.5-air.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*kimi-k2\\.7-code(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*kimi-k2\\.7-code.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*kimi-k2\\.6(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*kimi-k2\\.6.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*kimi-k2\\.5(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*kimi-k2\\.5.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*deepseek-v4-flash(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*deepseek-v4-flash.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*deepseek-v4-pro(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*deepseek-v4-pro.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*qwen3\\.5-plus(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*qwen3\\.5-plus.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*qwen3\\.5-flash(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*qwen3\\.5-flash.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*qwen-plus(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*qwen-plus.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*qwen-flash(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*qwen-flash.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*qwen3-vl-plus(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*qwen3-vl-plus.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*mimo-v2\\.5(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*mimo-v2\\.5.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*mimo-v2\\.5-pro(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*mimo-v2\\.5-pro.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*mimo-v2-flash(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*mimo-v2-flash.*",
    oldLevel: "off",
  },
] as const;
