/** Key 的创建用途；独立于 keyType，不包含仅供存量映射/缓存哨兵的 3 和 -1。 */
export const API_KEY_USAGE_SCENE = {
  CODING_PLAN: 1,
  STANDARD: 2,
} as const;

export type ApiKeyCreationUsageScene =
  (typeof API_KEY_USAGE_SCENE)[keyof typeof API_KEY_USAGE_SCENE];
