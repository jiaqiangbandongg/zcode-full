import { describe, expect, it } from "vitest";

import { exampleSidePaneFullView } from "@/side-pane-full-view/contract.example.js";
import type { SidePaneFullViewController } from "@/side-pane-full-view/contract.js";
import { sidePaneFullViewModule } from "@/side-pane-full-view/module.js";

function controller(fullView: SidePaneFullViewController["fullView"]): SidePaneFullViewController {
  return {
    fullView,
    enter: () => {},
    exit: () => {},
    toggle: () => {},
    setSurface: () => {},
    setFloating: () => {},
  };
}

describe("side-pane-full-view contract", () => {
  it("declares its module manifest", () => {
    expect(sidePaneFullViewModule.id).toBe("side-pane-full-view");
  });

  it("derives shell presentation only from the controller state", () => {
    expect(exampleSidePaneFullView(controller(null)).mode).toBe("normal");
    const floating = exampleSidePaneFullView(
      controller({ surface: "side-pane", floating: "collapsed" }),
    );
    expect(floating.mode).toBe("floating");
    expect(floating.sidebarVisible(true)).toBe(false);
    expect(
      exampleSidePaneFullView(controller({ surface: "conversation", floating: "expanded" })).mode,
    ).toBe("conversation");
  });
});
