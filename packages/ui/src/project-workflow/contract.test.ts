import { expect, it, vi } from "vitest";
import { saveCompletedRun } from "@/project-workflow/contract.example.js";
it("保留保存错误供宿主呈现，不提前发布已保存状态", async () => {
  const failure = new Error("connection closed");
  const save = vi.fn(async () => {
    throw failure;
  });
  await expect(
    saveCompletedRun(
      { save },
      { name: "review", scope: "project", meta: { description: "Review" } },
    ),
  ).rejects.toBe(failure);
});
