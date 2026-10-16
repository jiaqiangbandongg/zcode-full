import { describe, expect, it } from "vitest";
import { createGenUiTweakRegistry } from "./tweaks.js";

const target = {
  id: "1",
  label: "Player",
  selector: "#player",
  tagName: "div",
  rect: { x: 0, y: 0, width: 100, height: 80 },
};
const control = {
  callback: "tweak-1-1",
  label: "Radius",
  type: "range" as const,
  min: 0,
  max: 40,
  step: 1,
  currentValue: 12,
};
const registration = (id = "tweak-1", targetId = "1") => ({
  type: "register" as const,
  registrationId: id,
  targets: [{ ...target, id: targetId }],
  annotationControls: {
    controlsMode: "replace" as const,
    controls: [{ ...control, callback: `${id}-1` }],
  },
});

describe("Tweak registrations", () => {
  it("acknowledges controls and projects edits with the original value and target identity", () => {
    const registry = createGenUiTweakRegistry();
    expect(registry.handle(registration())).toEqual({
      annotationControls: registration().annotationControls,
    });
    expect(registry.groups()[0]?.controls[0]?.id).toBe("tweak-1-1");
    expect(registry.annotation({ "tweak-1-1": 20 }).changes).toEqual([
      {
        registrationId: "tweak-1",
        targetId: "1",
        annotationControlChanges: [{ callback: "tweak-1-1", previousValue: 12, value: 20 }],
      },
    ]);
    expect(registry.annotation({ "tweak-1-1": 12 }).changes).toEqual([]);
    expect(registry.annotation({ "tweak-1-1": 99 }).changes).toEqual([]);
  });
  it("lets the latest registration own a target and disposes it without affecting others", () => {
    const registry = createGenUiTweakRegistry();
    registry.handle(registration());
    registry.handle(registration("tweak-2"));
    registry.handle(registration("tweak-3", "2"));
    expect(registry.groups().map((g) => g.controls[0]?.id)).toEqual(["tweak-2-1", "tweak-3-1"]);
    registry.handle({ type: "dispose", registrationId: "tweak-2" });
    expect(registry.groups().map((g) => g.controls[0]?.id)).toEqual(["tweak-1-1", "tweak-3-1"]);
  });
  it("rejects stale updates and target changes without replacing the accepted registration", () => {
    const registry = createGenUiTweakRegistry();
    expect(() => registry.handle({ ...registration(), type: "update" })).toThrow();
    registry.handle(registration());
    expect(() =>
      registry.handle({ ...registration("tweak-1", "other"), type: "update" }),
    ).toThrow();
    expect(registry.groups()).toHaveLength(1);
  });
  it("rejects duplicate callbacks, invalid bindings and a 65th registration without changing accepted state", () => {
    const registry = createGenUiTweakRegistry();
    registry.handle(registration());
    const duplicate = registration("tweak-2", "2");
    duplicate.annotationControls.controls[0]!.callback = control.callback;
    expect(() => registry.handle(duplicate)).toThrow("Duplicate Tweak callback");
    const invalid = registration("tweak-2", "2");
    invalid.annotationControls.controls[0]!.currentValue = 50;
    expect(() => registry.handle(invalid)).toThrow();
    expect(registry.groups()).toHaveLength(1);
    for (let i = 2; i <= 64; i++) registry.handle(registration(`tweak-${i}`, String(i)));
    expect(() => registry.handle(registration("tweak-65", "65"))).toThrow();
    expect(registry.groups()).toHaveLength(64);
    registry.handle({ type: "dispose", registrationId: "tweak-64" });
    registry.handle(registration("tweak-65", "65"));
    expect(registry.groups()).toHaveLength(64);
  });
});
