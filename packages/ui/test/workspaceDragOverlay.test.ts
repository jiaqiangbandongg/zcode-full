import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { WorkspaceDragOverlay } from "@/project-sidebar/WorkspaceDragOverlay.js";

vi.mock("@/hooks/useSourceServerDisplayNames.js", () => ({
  useSourceServerDisplayNames: () => new Map([["source-a", "Build device"]]),
}));
it("拖拽预览使用设备显示名且保留项目名，本地项目不显示设备标签", () => {
  const render = (remote: boolean) =>
    renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(WorkspaceDragOverlay, {
          width: 264,
          tab: {
            id: "a",
            kind: "workspace",
            label: "project",
            workspacePath: "/project",
            ...(remote ? { workspaceIdentity: "remote:server:source-a:/project" } : {}),
          },
        }),
      ),
    );
  expect(render(true)).toContain("Build device");
  expect(render(true)).toContain("project");
  expect(render(false)).not.toContain("data-workspace-drag-device");
});

it("legacy 项目拖拽沿用普通项目行投影出的设备新名称", () => {
  const html = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(WorkspaceDragOverlay, {
        width: 264,
        sourceDisplayName: "Renamed device",
        tab: {
          id: "legacy",
          kind: "workspace",
          label: "project",
          workspacePath: "/project",
          workspaceIdentity: "remote:ssh:old:22:dev:/project",
          remoteTarget: { kind: "ssh", host: "old", username: "dev" },
        },
      }),
    ),
  );
  expect(html).toContain("Renamed device");
});
