import { describe, expect, it } from "vitest";
import { applyComposerPermissionGrant } from "../src/v4/composer/composerPermissionGrant.js";
import { sortPermissionOptions } from "../src/lib/permissionRequest.js";

describe("审批权限定向同步", () => {
  it("保留 Plan、正文和模型，同一授权不覆盖后来手动改选", () => {
    const draft = {
      text: "draft",
      updatedAt: 1,
      mode: "edit" as const,
      planEnabled: true,
      modelSelection: { providerId: "p", modelId: "m" },
    };
    const granted = applyComposerPermissionGrant(draft, { interactionId: "a" });
    expect(granted).toEqual({ ...draft, mode: "yolo", lastPermissionGrantId: "a" });
    const edited = { ...granted, mode: "build" as const };
    expect(applyComposerPermissionGrant(edited, { interactionId: "a" })).toBe(edited);
    expect(applyComposerPermissionGrant(edited, undefined)).toBe(edited);
    expect(applyComposerPermissionGrant(edited, { interactionId: "b" }).mode).toBe("yolo");
  });
  it("完全访问位于始终允许之后、拒绝之前，不靠序号决定 response", () => {
    const options = [
      { optionId: "deny", kind: "deny" },
      { optionId: "fullAccess", kind: "custom" },
      { optionId: "allowAlways", kind: "allow_always" },
      { optionId: "allowOnce", kind: "allow_once" },
    ].map((option) => ({
      ...option,
      name: option.optionId,
      response: { decision: "deny" as const },
    }));
    expect(sortPermissionOptions(options).map((option) => option.optionId)).toEqual([
      "allowOnce",
      "allowAlways",
      "fullAccess",
      "deny",
    ]);
  });
});
