import { describe, expect, it, vi } from "vitest";
import { buildRemoteWorkspaceIdentity } from "@zcode/shared";
import { createSessionCreateReporter } from "@/lib/sessionCreateTelemetry.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

describe("session_create", () => {
  it.each(["group", "project", "session"] as const)(
    "保留 %s 来源且不泄露路径/计费 projectId",
    async (source) => {
      const report = createSessionCreateReporter();
      const platform = { reportTelemetryEvent: vi.fn(async () => {}) };
      await report(platform, {
        sessionId: "s1",
        messageId: "first-command",
        workspacePath: "/private/repo",
        source,
        clientKind: "desktop",
      });
      expect(platform.reportTelemetryEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          elementName: "session_create",
          eventRegion: "app",
          eventType: "result",
          talkId: "s1",
          messageId: "first-command",
          eventExtraDetail: {
            create_source: source,
            client_kind: "desktop",
            workspace_kind: "local",
            remote_kind: "",
          },
        }),
      );
      expect(JSON.stringify(platform.reportTelemetryEvent.mock.calls)).not.toContain(
        "/private/repo",
      );
      expect(JSON.stringify(platform.reportTelemetryEvent.mock.calls)).not.toContain("project_id");
    },
  );

  it("手机和 SSH 是两个独立维度，同路径不同远端分别计数，重复回调不重复", async () => {
    const report = createSessionCreateReporter();
    const platform = { reportTelemetryEvent: vi.fn(async () => {}) };
    const input = {
      sessionId: "s1",
      messageId: "first-command",
      workspacePath: "/repo",
      source: "session",
      clientKind: "mobile",
    } as const;
    for (const host of ["one", "one", "two"]) {
      await report(platform, {
        ...input,
        workspaceIdentity: buildRemoteWorkspaceIdentity("/repo", {
          kind: "ssh",
          host,
          username: "tester",
        }),
      });
    }
    expect(platform.reportTelemetryEvent).toHaveBeenCalledTimes(2);
    expect(platform.reportTelemetryEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventExtraDetail: expect.objectContaining({
          client_kind: "mobile",
          workspace_kind: "remote",
          remote_kind: "ssh",
        }),
      }),
    );
  });

  it("上报失败不传播到创建动作", async () => {
    await expect(
      createSessionCreateReporter()(
        { reportTelemetryEvent: vi.fn().mockRejectedValue(new Error("offline")) },
        {
          sessionId: "s1",
          messageId: "first-command",
          workspacePath: "/repo",
          source: "session",
          clientKind: "desktop",
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("默认空态为 session，Project 入口和 Group 重定位保存各自来源", () => {
    const store = useZCodeSessionStore.getState();
    expect(store.getWorkspaceState("/telemetry-source-test").draftCreateSource).toBe("session");
    store.startDraft("/telemetry-source-test", undefined, undefined, { createSource: "project" });
    expect(store.getWorkspaceState("/telemetry-source-test").draftCreateSource).toBe("project");
    store.startDraft("/telemetry-source-test", undefined, undefined, {
      groupedDraftPlacement: { type: "group", groupId: "g1" },
    });
    expect(store.getWorkspaceState("/telemetry-source-test").draftCreateSource).toBe("group");
    store.startDraft("/telemetry-source-test");
    expect(store.getWorkspaceState("/telemetry-source-test").draftCreateSource).toBe("session");
  });
});
