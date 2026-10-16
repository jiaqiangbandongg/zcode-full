import { describe, expect, it } from "vitest";

describe("app launch coordinator", () => {
  it("sends app_launch immediately when no OAuth callback is pending", async () => {
    const { createAppLaunchCoordinator } = await import("../src/main/appLaunchCoordinator.js");
    const gate = {
      consumeCalls: 0,
      consume() {
        this.consumeCalls += 1;
        return true;
      },
    };

    const coordinator = createAppLaunchCoordinator(gate);

    expect(
      coordinator.onRendererReady({
        hasPendingOAuthCallback: false,
        rendererId: 1,
      }),
    ).toBe(true);
    expect(coordinator.onOAuthCallbackHandled({ rendererId: 1 })).toBe(false);
    expect(gate.consumeCalls).toBe(1);
  });

  it("waits for OAuth callback handling before sending delayed app_launch", async () => {
    const { createAppLaunchCoordinator } = await import("../src/main/appLaunchCoordinator.js");
    const gate = {
      consumed: false,
      consume() {
        if (this.consumed) {
          return false;
        }
        this.consumed = true;
        return true;
      },
    };

    const coordinator = createAppLaunchCoordinator(gate);

    expect(
      coordinator.onRendererReady({
        hasPendingOAuthCallback: true,
        rendererId: 1,
      }),
    ).toBe(false);
    expect(coordinator.onOAuthCallbackHandled({ rendererId: 1 })).toBe(true);
    expect(coordinator.onOAuthCallbackHandled({ rendererId: 1 })).toBe(false);
    expect(
      coordinator.onRendererReady({
        hasPendingOAuthCallback: false,
        rendererId: 1,
      }),
    ).toBe(false);
  });

  it("does not let another renderer consume app_launch while waiting for OAuth callback", async () => {
    const { createAppLaunchCoordinator } = await import("../src/main/appLaunchCoordinator.js");
    const gate = {
      consumed: false,
      consume() {
        if (this.consumed) {
          return false;
        }
        this.consumed = true;
        return true;
      },
    };

    const coordinator = createAppLaunchCoordinator(gate);

    expect(
      coordinator.onRendererReady({
        hasPendingOAuthCallback: true,
        rendererId: 1,
      }),
    ).toBe(false);
    expect(
      coordinator.onRendererReady({
        hasPendingOAuthCallback: false,
        rendererId: 2,
      }),
    ).toBe(false);
    expect(coordinator.onOAuthCallbackHandled({ rendererId: 2 })).toBe(false);
    expect(coordinator.onOAuthCallbackHandled({ rendererId: 1 })).toBe(true);
  });
});
