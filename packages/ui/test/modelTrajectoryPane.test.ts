import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useModelTrajectory.js", () => ({
  useModelTrajectory: () => ({
    data: null,
    error: null,
    loading: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ openInFileManager: vi.fn() }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

import { ModelTrajectoryPane } from "@/ModelTrajectoryPane.js";

describe("ModelTrajectoryPane", () => {
  it("uses a native overflow container for the trajectory content", () => {
    const html = renderToStaticMarkup(
      createElement(ModelTrajectoryPane, {
        taskId: "task-1",
        workspacePath: "/repo",
      }),
    );

    expect(html).toContain("min-h-0 flex-1 overflow-x-hidden overflow-y-auto");
    expect(html).not.toContain('data-slot="scroll-area"');
  });
});
