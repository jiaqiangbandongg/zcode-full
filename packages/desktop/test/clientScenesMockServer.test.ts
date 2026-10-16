import { describe, expect, it } from "vitest";
import {
  AUTOMATIONS_HOME_CLIENT_SCENES_FIXTURE,
  startClientScenesMockServer,
} from "./e2e/helpers/client-scenes-mock-server.js";

describe("off-peak automations Client Scenes E2E fixture", () => {
  it("为布局 case 固定提供三张闲时与四张定时模板", () => {
    const idleScene = AUTOMATIONS_HOME_CLIENT_SCENES_FIXTURE.data.find(
      (scene) => scene.scene === "off-peak-task",
    );
    const scheduledScene = AUTOMATIONS_HOME_CLIENT_SCENES_FIXTURE.data.find(
      (scene) => scene.scene === "scheduled-task",
    );

    expect(idleScene?.options.prompts?.items).toHaveLength(3);
    expect(scheduledScene?.options.prompts?.items).toHaveLength(4);
    expect(scheduledScene?.options.cronExpr?.items).toHaveLength(4);
  });

  it("通过 client scenes API 返回与 service 契约一致的 envelope", async () => {
    const server = await startClientScenesMockServer();
    try {
      const response = await fetch(`${server.baseUrl}/api/v1/client/scenes`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(AUTOMATIONS_HOME_CLIENT_SCENES_FIXTURE);
    } finally {
      await server.stop();
    }
  });
});
