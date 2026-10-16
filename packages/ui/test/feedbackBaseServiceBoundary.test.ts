import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(path: string): string {
  return readFileSync(path, "utf8");
}

describe("feedback base service boundary", () => {
  it("keeps feedback on the base service when workspace services are disconnected", () => {
    const rootSource = readSource("packages/ui/src/Root.tsx");
    const rootWorkspaceContentSource = readSource(
      "packages/ui/src/root/RootWorkspaceContent.tsx",
    );
    const appSource = readSource("packages/ui/src/App.tsx");

    expect(rootSource).toContain(
      "baseFeedbackService={services.feedbackService}",
    );
    expect(rootWorkspaceContentSource).toContain(
      "baseFeedbackService={baseFeedbackService}",
    );
    expect(appSource).toContain(
      "<FeedbackHost feedbackService={baseFeedbackService} platform={platform} />",
    );
    expect(appSource).not.toContain(
      "<FeedbackHost feedbackService={services?.feedbackService} platform={platform} />",
    );
  });
});
