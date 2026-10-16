import assert from "node:assert/strict";
import { test } from "node:test";

test("golden contract describes a callable port", async () => {
  const port = { ping: async () => "ok" as const };
  assert.equal(await port.ping(), "ok");
});
