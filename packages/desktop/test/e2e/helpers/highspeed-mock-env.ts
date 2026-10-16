import type { HighspeedMockScenario } from "@zcode/shared";

export const HIGHSPEED_MOCK_SCENARIO_ENV = "ZCODE_HIGHSPEED_MOCK_SCENARIO";

// Mock 场景在 Host 进程内固定、draw 后冷却 2 分钟，一个 spec 文件只能完成一次 draw，
// 所以每个场景对应一个 spec 文件（docs/highspeed/highspeed-card-spec.md §7）。
// 文件名互不为子串，按 includes 匹配不会串场景。
const HIGHSPEED_E2E_SPEC_SCENARIOS: ReadonlyArray<readonly [string, HighspeedMockScenario]> = [
  ["conversation-session-highspeed-card.test.ts", "hit-fast"],
  ["conversation-session-highspeed-card-draw-timeout.test.ts", "hit-after-timeout"],
  ["conversation-session-highspeed-card-draw-miss.test.ts", "miss"],
];

/** 未登记的 spec 返回 null：Host 不装配 Mock，避免普通会话在默认套件里意外抽到卡。 */
export function resolveHighspeedE2EMockScenario(
  specs: readonly string[],
): HighspeedMockScenario | null {
  for (const spec of specs) {
    const normalized = spec.replaceAll("\\", "/");
    const matched = HIGHSPEED_E2E_SPEC_SCENARIOS.find(([marker]) => normalized.includes(marker));
    if (matched) return matched[1];
  }
  return null;
}
