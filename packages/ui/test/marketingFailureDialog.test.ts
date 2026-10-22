// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MarketingFailureDialog } from "@/components/marketing-touch/MarketingFailureDialog.js";

afterEach(cleanup);
it("renders a literal message and one acknowledgement action", () => {
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
  const alert = screen.getByRole("alert");
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
