// @vitest-environment jsdom
import { createRequire } from "node:module";
import { createElement } from "react";
import * as esm from "@radix-ui/react-collapsible";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const commonjs = createRequire(import.meta.url)("@radix-ui/react-collapsible") as typeof esm;
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe.each([
  ["ESM", esm],
  ["CommonJS", commonjs],
] as const)("Collapsible measurement %s", (_name, primitive) => {
  const { Root, Trigger, Content } = primitive;
  it("skips hidden measurements while retaining expansion and presence transitions", () => {
    const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    render(
      createElement(
        Root,
        null,
        createElement(Trigger, null, "Toggle"),
        createElement(
          Content,
          { "data-testid": "content" } as React.ComponentProps<typeof Content>,
          "Details",
        ),
      ),
    );
    expect(screen.getByTestId("content").hidden).toBe(true);
    expect(measure).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
    expect(screen.getByTestId("content").hidden).toBe(false);
    expect(screen.getByText("Details")).toBeTruthy();
    expect(measure).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
    expect(screen.getByTestId("content").hidden).toBe(true);
  });
  it.each(["defaultOpen", "forceMount"] as const)("retains visible %s measurements", (mode) => {
    const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    render(
      createElement(
        Root,
        { defaultOpen: mode === "defaultOpen" },
        createElement(
          Content,
          {
            forceMount: mode === "forceMount" ? true : undefined,
            "data-testid": "content",
          } as React.ComponentProps<typeof Content>,
          "Details",
        ),
      ),
    );
    expect(screen.getByTestId("content").hidden).toBe(false);
    expect(measure).toHaveBeenCalled();
  });
});
