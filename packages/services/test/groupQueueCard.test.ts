import { describe, expect, it, vi } from "vitest";
import { createGroupQueueCardSync } from "#src/bots/groupQueueCard.js";
import type { BotGroupInputProgress } from "@zcode/shared";

function setup(initial: BotGroupInputProgress = { status: "waiting" }) {
  let saved: BotGroupInputProgress | undefined = initial;
  const render = vi.fn(async () => {});
  const sync = createGroupQueueCardSync({
    read: async () => saved,
    mutate: async (_key, update) => (saved ? (saved = update(saved)) : undefined),
    render,
  });
  return {
    sync,
    render,
    read: () => saved,
    disable: () => {
      saved = undefined;
    },
  };
}

describe("queue card lifecycle", () => {
  it("updates the same card after queued input starts and completes", async () => {
    const { sync, render, read } = setup();
    await sync.attach("input", "om_card");
    await sync.update("input", "working");
    await sync.update("input", "done");
    expect(render.mock.calls).toEqual([
      ["input", "om_card", "working"],
      ["input", "om_card", "done"],
    ]);
    expect(read()?.cardStatus).toBe("done");
  });

  it("catches up when card creation finishes after completion and ignores late queue acknowledgement", async () => {
    const { sync, render } = setup();
    await sync.update("input", "working");
    await sync.update("input", "done");
    await sync.update("input", "waiting");
    await sync.attach("input", "om_late");
    await sync.update("input", "done");
    expect(render.mock.calls).toEqual([["input", "om_late", "done"]]);
  });

  it.each(["failed", "stopped", "cancelled", "discarded"] as const)(
    "renders terminal %s and rejects late working state",
    async (state) => {
      const { sync, render } = setup();
      await sync.attach("input", "om_card");
      await sync.update("input", state);
      await sync.update("input", "working");
      expect(render.mock.calls).toEqual([["input", "om_card", state]]);
    },
  );

  it("does not update a revoked group or lose the persisted target after recreation", async () => {
    const { sync, render, disable } = setup({
      status: "working",
      cardMessageId: "om_saved",
      cardStatus: "waiting",
    });
    await sync.update("input", "done");
    expect(render).toHaveBeenCalledWith("input", "om_saved", "done");
    disable();
    await sync.update("input", "done");
    expect(render).toHaveBeenCalledTimes(1);
  });
});
