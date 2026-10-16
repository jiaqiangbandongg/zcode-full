import { describe, expect, it, vi } from "vitest";
import {
  bumpTaskListMembershipVersion,
  getTaskListMembershipVersion,
  subscribeTaskListMembershipVersion,
} from "@/v4/taskListMembershipVersion.js";

describe("taskListMembershipVersion", () => {
  it("bump 后版本号递增并通知订阅者", () => {
    const before = getTaskListMembershipVersion();
    const listener = vi.fn();
    const unsubscribe = subscribeTaskListMembershipVersion(listener);
    bumpTaskListMembershipVersion();
    expect(getTaskListMembershipVersion()).toBe(before + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    bumpTaskListMembershipVersion();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
