import { describe, expect, it } from "vitest";
import { reconcileProjectOrder, moveProjectOrder } from "@/project-sidebar/projectOrder.js";
describe("controller project order", () => {
  it("initializes once, retains offline slots and appends discovered projects", () => {
    expect(reconcileProjectOrder([], ["local:a", "ssh:b"])).toEqual(["local:a", "ssh:b"]);
    expect(reconcileProjectOrder(["ssh:b", "local:a"], ["local:a", "ssh:b", "docker:c"])).toEqual([
      "ssh:b",
      "local:a",
      "docker:c",
    ]);
    expect(reconcileProjectOrder(["ssh:b", "local:a"], ["local:a"])).toEqual(["ssh:b", "local:a"]);
  });
  it("moves between hosts without moving projects outside the current pin section", () => {
    expect(
      moveProjectOrder(["pin:p", "local:a", "ssh:b"], ["local:a", "ssh:b"], "ssh:b", "local:a"),
    ).toEqual(["pin:p", "ssh:b", "local:a"]);
    expect(moveProjectOrder(["pin:p", "local:a"], ["local:a"], "local:a", "pin:p")).toEqual([
      "pin:p",
      "local:a",
    ]);
  });
});
