import { describe, expect, it } from "vitest";
import { buildProtocolPermissionOptions } from "../src/permission-options.js";

describe("Guarded single-use protocol options", () => {
  it("single-use excludes both project and session grants", () => {
    for (const optionsPolicy of [undefined, "session-always-allow", "no-always-allow"] as const) {
      expect(
        buildProtocolPermissionOptions({
          toolName: "Bash",
          approvalMode: "user-once",
          optionsPolicy,
        }).map((option) => option.kind),
      ).toEqual(["allow_once", "deny"]);
    }
  });
  it("explicit constraint removes persistence; absent constraint preserves old options", () => {
    expect(
      buildProtocolPermissionOptions({
        toolName: "Bash",
        approvalMode: "user-once",
        input: { command: "rm -rf build" },
      }).map((o) => o.kind),
    ).toEqual(["allow_once", "deny"]);
    expect(
      buildProtocolPermissionOptions({ toolName: "Bash", suggestedPermissionUpdates: [] }).map(
        (o) => o.kind,
      ),
    ).toEqual(["allow_once", "allow_always", "deny"]);
  });
});
