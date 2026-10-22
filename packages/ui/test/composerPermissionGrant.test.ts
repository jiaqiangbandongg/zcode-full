import { describe, expect, it } from "vitest";
import { sortPermissionOptions } from "../src/lib/permissionRequest.js";

describe("审批权限定向同步", () => {
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
