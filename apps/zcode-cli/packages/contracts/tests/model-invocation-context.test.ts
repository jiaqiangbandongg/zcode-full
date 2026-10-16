import { describe, expect, it } from "vitest";
import {
  getCurrentModelInvocationContext,
  runWithModelInvocationContext,
} from "../src/model/invocation-context.js";

describe("ModelInvocationContext", () => {
  it("keeps invocation context while an async stream is consumed outside the creation callback", async () => {
    const stream = runWithModelInvocationContext(
      { metadata: { querySource: "test-stream" } },
      async function* () {
        await Promise.resolve();
        yield getCurrentModelInvocationContext()?.metadata?.querySource;
      },
    );

    expect(getCurrentModelInvocationContext()).toBeUndefined();

    const values: unknown[] = [];
    for await (const value of stream) values.push(value);

    expect(values).toEqual(["test-stream"]);
    expect(getCurrentModelInvocationContext()).toBeUndefined();
  });
});
