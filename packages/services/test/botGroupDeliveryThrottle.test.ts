import { afterEach, expect, it, vi } from "vitest";
import { createGroupDeliveryThrottle } from "../src/bots/groupDeliveryThrottle.js";
afterEach(() => vi.useRealTimers());
it("spaces sends across bots in the same group while leaving other groups independent", async () => {
  vi.useFakeTimers();
  const wait = createGroupDeliveryThrottle();
  const sent: string[] = [];
  const first = wait("feishu:oc_a").then(() => sent.push("a1"));
  const second = wait("feishu:oc_a").then(() => sent.push("a2"));
  const other = wait("feishu:oc_b").then(() => sent.push("b1"));
  await Promise.all([first, other]);
  expect(sent).toEqual(["a1", "b1"]);
  await vi.advanceTimersByTimeAsync(250);
  await second;
  expect(sent).toEqual(["a1", "b1", "a2"]);
});
