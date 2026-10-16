// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  status: "loading" as "loading" | "ready" | "error",
  retry: vi.fn(),
}));
vi.mock("@/settings/CodingPlanUpgradeDialogProvider.js", () => ({
  useOptionalCodingPlanUpgradeDialog: () => ({ inventory: { status: h.status, retry: h.retry } }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
import { CodingPlanEntryButton } from "@/settings/CodingPlanEntryButton.js";
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("disables loading, retries failure without purchasing, and requires a fresh ready click", () => {
  const purchase = vi.fn();
  const view = render(createElement(CodingPlanEntryButton, { onClick: purchase }, "Upgrade"));
  const button = screen.getByRole("button") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(purchase).not.toHaveBeenCalled();
  h.status = "error";
  view.rerender(createElement(CodingPlanEntryButton, { onClick: purchase }, "Upgrade"));
  expect(button.textContent).toBe("purchase.entry.retry");
  fireEvent.click(button);
  expect(h.retry).toHaveBeenCalledTimes(1);
  expect(purchase).not.toHaveBeenCalled();
  h.status = "ready";
  view.rerender(createElement(CodingPlanEntryButton, { onClick: purchase }, "Upgrade"));
  expect(purchase).not.toHaveBeenCalled();
  fireEvent.click(button);
  expect(purchase).toHaveBeenCalledTimes(1);
});
