import { describe, expect, it } from "vitest";
import type { SkillSummary } from "@zcode/shared";
import { buildPluginCreatorPrefill } from "@/settings/pluginCreatorPrefill.js";

const creator: SkillSummary = {
  id: "official-creator",
  name: "plugin-creator",
  description: "Create plugins",
  body: "",
  path: "/remote space/plugins/creator/SKILL.md",
  scope: "plugin",
  enabled: true,
  pluginName: "plugin-creator",
  pluginId: "plugin-creator@zcode-plugins-official",
};
describe("Plugin Creator prefill", () => {
  it("binds the real official skill path and preserves trailing space without submission", () => {
    const result = buildPluginCreatorPrefill([creator]);
    expect(result.initialPrompt).toBe("[$plugin-creator](/remote space/plugins/creator/SKILL.md) ");
    expect(result.initialPromptMention).toMatchObject({
      id: "skill:official-creator",
      category: "skills",
      value: "plugin-creator",
      data: { path: creator.path, scope: "plugin" },
    });
    expect(result).not.toHaveProperty("autoSubmit");
  });
  it("rejects missing, disabled and wrong-market same-name skills", () => {
    for (const entries of [
      [],
      [{ ...creator, enabled: false }],
      [{ ...creator, path: "" }],
      [{ ...creator, pluginId: "plugin-creator@third-party" }],
    ]) {
      expect(() => buildPluginCreatorPrefill(entries)).toThrow();
    }
  });
});

it("discards a completed lookup after its workspace identity is superseded", async () => {
  const { loadPluginCreatorPrefill } = await import("@/settings/pluginCreatorPrefill.js");
  let finish!: (result: { skills: SkillSummary[] }) => void;
  let current = true;
  const result = loadPluginCreatorPrefill(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    () => current,
  );
  current = false;
  finish({ skills: [creator] });
  expect(await result).toBeNull();
});
