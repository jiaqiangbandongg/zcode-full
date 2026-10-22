import assert from "node:assert/strict";
import test from "node:test";

import { selectDefaultBranchRef } from "../affected-unit-test-baseline.mjs";

test("prefers origin/staging as the default affected-test baseline", () => {
  const availableRefs = new Set(["origin/staging", "origin/main"]);

  const selected = selectDefaultBranchRef({
    originHead: "origin/main",
    hasCommit: (ref) => availableRefs.has(ref),
  });

  assert.equal(selected, "origin/staging");
});
