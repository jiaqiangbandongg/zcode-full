// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudContentDialog } from "@/components/cloud-content-dialog/CloudContentDialog.js";
import type { CloudContentDialogPayload } from "@/components/cloud-content-dialog/cloudContentDialogTypes.js";

afterEach(cleanup);
const payload: CloudContentDialogPayload = {
  schemaVersion: 1,
  id: "new-feature",
  revision: 1,
  locale: "en-US",
  kind: "feature",
  dialog: {
    hero: { type: "image", src: "https://example.com/hero.png", alt: "Feature preview" },
    title: "New feature",
    description: { format: "html", text: "<p>A <b>new</b> feature</p>" },
    buttons: [
      { id: "copy", label: "Copy", variant: "primary", actionId: "copy" },
      { id: "claim", label: "Claim", variant: "secondary", actionId: "claim" },
      { id: "close", label: "Later", variant: "link", actionId: "close" },
    ],
  },
  actions: {
    copy: { type: "copy_text", text: "share" },
    claim: { type: "claim_plan", planId: "test" },
    close: { type: "close" },
  },
};

describe("CloudContentDialog", () => {
  it("keeps initial focus in the parent dialog so a bundle cannot swallow Escape", async () => {
    const onClose = vi.fn();
    render(
      createElement(CloudContentDialog, {
        payload: {
          ...payload,
          dialog: {
            ...payload.dialog,
            hero: {
              type: "interactive_bundle",
              runtime: "zcode-hero-sandbox-v1",
              resolvedUrl: "https://example.com/hero.html",
              data: {},
            },
          },
        },
        open: true,
        onClose,
        handlers: {},
        labels: { actionFailed: "Failed" },
      }),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector('[data-slot="dialog-close"]')),
    );
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("renders rich title and button without nested actions or losing the close event", () => {
    const onClose = vi.fn();
    render(
      createElement(CloudContentDialog, {
        payload: {
          ...payload,
          dialog: {
            ...payload.dialog,
            formattedTitle: { format: "markdown", text: "**New** feature" },
            buttons: [
              {
                id: "close",
                actionId: "close",
                label: "Later",
                variant: "primary",
                formattedLabel: {
                  format: "html",
                  text: '<p><a href="https://example.com"><b style="font-style:italic" class="underline">Later</b></a><script>bad()</script></p>',
                },
              },
            ],
          },
        },
        open: true,
        onClose,
        handlers: {},
        labels: { actionFailed: "Failed" },
      }),
    );
    expect(screen.getByRole("heading").querySelector("strong")?.textContent).toBe("New");
    const button = screen.getByRole("button", { name: "Later" });
    expect(button.querySelector("p,a,script,svg")).toBeNull();
    expect(button.querySelector("b")?.style.fontStyle).toBe("italic");
    expect(button.querySelector("b")?.classList.contains("underline")).toBe(true);
    expect(button.querySelector("b")?.classList.contains("text-foreground")).toBe(false);
    fireEvent.click(button.querySelector("b")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("keeps action buttons text-only before and after copying", async () => {
    render(
      createElement(CloudContentDialog, {
        payload,
        open: true,
        onClose: vi.fn(),
        handlers: { copy_text: vi.fn() },
        labels: { actionFailed: "Failed", copySucceeded: "Copied" },
      }),
    );
    for (const button of screen.getAllByTestId("cloud-dialog-action")) {
      expect(button.querySelector("svg")).toBeNull();
    }
    fireEvent.click(screen.getByText("Copy"));
    await waitFor(() => expect(screen.getByText("Copied")).toBeTruthy());
    expect(screen.getByText("Copied").querySelector("svg")).toBeNull();
  });
  it("applies button theme without changing close actions", () => {
    const onClose = vi.fn();
    render(
      createElement(CloudContentDialog, {
        payload: {
          ...payload,
          dialog: {
            ...payload.dialog,
            buttons: [
              {
                id: "close",
                label: "Themed close",
                actionId: "close",
                variant: "primary",
                theme: {
                  variant: "ghost",
                  class: "rounded-lg text-foreground",
                  style: "color: red;position:fixed;background-image:url(https://example.com/x)",
                },
              },
            ],
          },
        },
        open: true,
        onClose,
        handlers: {},
        labels: { actionFailed: "Failed" },
      }),
    );
    const button = screen.getByRole("button", { name: "Themed close" });
    expect(button.dataset.variant).toBe("ghost");
    expect(button.className).toContain("rounded-lg");
    expect(button.className).not.toContain("rounded-full");
    expect(button.style.color).toBe("red");
    expect(button.style.position).toBe("");
    expect(button.style.backgroundImage).toBe("");
    fireEvent.click(button);
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("removes the shell border and clips hero media to the top corners", () => {
    render(
      createElement(CloudContentDialog, {
        payload,
        open: true,
        onClose: vi.fn(),
        handlers: {},
        labels: { actionFailed: "Failed" },
      }),
    );
    expect(screen.getByTestId("cloud-content-dialog").classList.contains("border-0")).toBe(true);
    expect(
      screen.getByTestId("cloud-content-dialog").classList.contains("cloud-content-dialog"),
    ).toBe(true);
    expect(screen.getByTestId("cloud-content-dialog").className).not.toContain(
      "[&_[data-slot=dialog-close]]:bg-popover",
    );
    expect(screen.getByTestId("cloud-content-dialog").className).toContain(
      "[&_[data-slot=dialog-close]]:rounded-full",
    );
    const hero = screen.getByTestId("cloud-dialog-hero-slot");
    expect(hero.classList.contains("rounded-t-2xl")).toBe(true);
    expect(hero.classList.contains("overflow-hidden")).toBe(true);
    expect(
      document
        .querySelector('[data-slot="dialog-overlay"]')!
        .classList.contains("backdrop-filter-none!"),
    ).toBe(false);
  });
  it("disables backdrop compositing only for interactive iframe dialogs", () => {
    render(
      createElement(CloudContentDialog, {
        payload: {
          ...payload,
          dialog: {
            ...payload.dialog,
            hero: {
              type: "interactive_bundle",
              runtime: "zcode-hero-sandbox-v1",
              resolvedUrl: "https://example.com/hero.html",
              data: {},
            },
          },
        },
        open: true,
        onClose: vi.fn(),
        handlers: {},
        labels: { actionFailed: "Failed" },
      }),
    );
    expect(
      document
        .querySelector('[data-slot="dialog-overlay"]')!
        .classList.contains("backdrop-filter-none!"),
    ).toBe(true);
  });
  it("supports an explicit focus target when async loading disabled the opener", async () => {
    const target = document.createElement("button");
    document.body.append(target);
    const props = {
      payload,
      open: true,
      onClose: vi.fn(),
      handlers: {},
      labels: { actionFailed: "Failed" },
      returnFocusRef: { current: target },
    };
    const { rerender } = render(createElement(CloudContentDialog, props));
    rerender(createElement(CloudContentDialog, { ...props, open: false }));
    try {
      await waitFor(() => expect(document.activeElement).toBe(target));
    } finally {
      target.remove();
    }
  });
  it("restores focus to the connected opener after closing a controlled dialog", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const props = {
      payload,
      open: true,
      onClose: vi.fn(),
      handlers: {},
      labels: { actionFailed: "Failed" },
    };
    const { rerender } = render(createElement(CloudContentDialog, props));
    expect(document.activeElement).not.toBe(opener);
    rerender(createElement(CloudContentDialog, { ...props, open: false }));
    try {
      await waitFor(() => expect(document.activeElement).toBe(opener));
    } finally {
      opener.remove();
    }
  });
  it("shows a host-localized copy acknowledgement without changing the payload or closing", async () => {
    const onClose = vi.fn();
    render(
      createElement(CloudContentDialog, {
        payload,
        open: true,
        onClose,
        handlers: { copy_text: vi.fn() },
        labels: { actionFailed: "Failed", copySucceeded: "Copied" },
      }),
    );
    fireEvent.click(screen.getByText("Copy"));
    expect(await screen.findByText("Copied")).toBeTruthy();
    expect(payload.dialog.buttons[0]?.label).toBe("Copy");
    expect(onClose).not.toHaveBeenCalled();
  });
  it("does not let a closed instance's pending dismissal close a reopened dialog", async () => {
    let resolve: () => void = () => {};
    const onClose = vi.fn();
    const dismiss = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const content = {
      ...payload,
      actions: { ...payload.actions, copy: { type: "dismiss_content" as const } },
    };
    const props = {
      payload: content,
      open: true,
      onClose,
      handlers: { dismiss_content: dismiss },
      labels: { actionFailed: "Failed" },
    };
    const { rerender } = render(createElement(CloudContentDialog, props));
    fireEvent.click(screen.getByText("Copy"));
    rerender(createElement(CloudContentDialog, { ...props, open: false }));
    rerender(createElement(CloudContentDialog, props));
    resolve();
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Copy" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
  it("renders payload fields and ordered buttons, only dispatching available host actions", async () => {
    const copy = vi.fn();
    const onClose = vi.fn();
    render(
      createElement(CloudContentDialog, {
        payload,
        open: true,
        onClose,
        handlers: { copy_text: copy },
        labels: { actionFailed: "Action failed" },
      }),
    );
    expect(screen.getByRole("heading").textContent).toBe("New feature");
    expect(screen.getByText("new").tagName).toBe("B");
    const buttons = screen.getAllByTestId("cloud-dialog-action");
    expect(buttons.map((button) => button.textContent)).toEqual(["Copy", "Claim", "Later"]);
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(copy).toHaveBeenCalledWith({ type: "copy_text", text: "share" }));
    fireEvent.click(screen.getByText("Later"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("blocks duplicate actions, surfaces failures, permits retry and never blocks closing", async () => {
    let reject: (error: Error) => void = () => {};
    const copy = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const onClose = vi.fn();
    render(
      createElement(CloudContentDialog, {
        payload,
        open: true,
        onClose,
        handlers: { copy_text: copy },
        labels: { actionFailed: "Action failed" },
      }),
    );
    fireEvent.click(screen.getByText("Copy"));
    fireEvent.click(screen.getByText("Copy"));
    expect(copy).toHaveBeenCalledTimes(1);
    reject(new Error("failure"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Action failed"));
    fireEvent.click(screen.getByText("Copy"));
    expect(copy).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByText("Later"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
