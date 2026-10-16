// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MarketingFailureDialog } from "@/components/marketing-touch/MarketingFailureDialog.js";

afterEach(cleanup);
it("uses an info Alert, literal message and one acknowledgement without a visible title", () => {
  const onClose = vi.fn();
  render(
    createElement(MarketingFailureDialog, {
      message: "今日额度已领完。\n<b>请明天再来</b>",
      title: "领取失败",
      acknowledge: "知道了",
      onClose,
    }),
  );
  const dialog = screen.getByRole("dialog");
  expect(screen.getByRole("heading").classList.contains("sr-only")).toBe(true);
  const alert = screen.getByRole("alert");
  for (const className of ["border-0", "bg-transparent", "p-0"]) {
    expect(alert.classList.contains(className)).toBe(true);
  }
  expect(alert.querySelector("svg")).not.toBeNull();
  expect(alert.querySelector("[data-slot=alert-description]")?.textContent).toBe(
    "今日额度已领完。\n<b>请明天再来</b>",
  );
  expect(
    dialog.querySelector("b,iframe,[data-slot=alert-title],[data-slot=dialog-close]"),
  ).toBeNull();
  expect(screen.getAllByRole("button")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "知道了" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});
