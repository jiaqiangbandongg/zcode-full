import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTaskTitleMarqueeDatabasePath } from "./e2e/helpers/task-title-marquee-fixture.js";

describe("task title marquee fixture storage isolation", () => {
  it("writes the task index into the runtime helper's fixed E2E storage root", () => {
    const homeDir = join("tmp", "task-title-marquee");

    expect(resolveTaskTitleMarqueeDatabasePath(homeDir)).toBe(
      join(homeDir, ".zcode", "v2", "tasks-index.sqlite"),
    );
  });
});
