// @vitest-environment jsdom
import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

const groups = [
  {
    key: "a",
    label: "Provider A",
    labelBadge: "Individual",
    logo: { type: "builtin" as const, key: "deepseek" },
    items: [
      { key: "flash", value: "a/flash", name: "GLM-5.3-Flash", supportsVisionInput: true },
      { key: "glm", value: "a/glm", name: "GLM-5.3" },
    ],
  },
  {
    key: "b",
    label: "Provider B",
    labelBadge: "API",
    items: [{ key: "fixed", value: "b/fixed", name: "Fixed model" }],
  },
];

function Harness({
  modelName,
  invalid = false,
  loading = false,
  locked = [],
  onManageModels,
  empty = false,
  levelsOverride,
  initialThought,
  effortShortcutLabel = "Ctrl+T",
}: {
  modelName?: string;
  invalid?: boolean;
  loading?: boolean;
  locked?: string[];
  onManageModels?: () => void;
  empty?: boolean;
  levelsOverride?: { value: string; label: string }[];
  initialThought?: string;
  effortShortcutLabel?: string;
}) {
  const [model, setModel] = useState(empty ? "" : "a/flash");
  const [thought, setThought] = useState(initialThought ?? (invalid ? "missing" : "high"));
  const [open, setOpen] = useState(true);
  const levels =
    model === "b/fixed"
      ? [{ value: "disabled", label: "Off" }]
      : [
          { value: "disabled", label: "Off" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ];
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: "en-US" },
    createElement(
      TooltipProvider,
      null,
      createElement(ModelConfigSelect, {
        modelGroups: loading
          ? []
          : groups.map((group) => ({
              ...group,
              items: group.items.map((item) =>
                item.value === "a/flash" && modelName ? { ...item, name: modelName } : item,
              ),
            })),
        normalizedValue: model,
        triggerLabel:
          groups.flatMap((group) => group.items).find((item) => item.value === model)?.name ??
          "Select model",
        tooltipTitle:
          groups.flatMap((group) => group.items).find((item) => item.value === model)?.name ??
          "Select model",
        showManageModelsAction: Boolean(onManageModels),
        manageModelsLabel: "Manage models",
        onManageModels,
        lockReasonMessage: "",
        isItemLocked: (value: string) => locked.includes(value),
        onValueChange: (value: string) => {
          setModel(value);
          setThought(value === "b/fixed" ? "disabled" : "high");
        },
        open,
        onOpenChange: setOpen,
        focusSelectorOnClose: null,
        composerOptions: {
          providerLabel: "Provider",
          modelsLabel: "Models",
          effortLabel: "Effort",
          effortShortcutLabel,
          selectModelLabel: "Select model",
          levels: loading ? [] : (levelsOverride ?? levels),
          value: thought,
          onValueChange: setThought,
        },
      }),
    ),
  );
}

beforeEach(() => {
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(cleanup);

describe("composer combined model and thinking picker", () => {
  it("rolls between the open and closed content without replacing the trigger", async () => {
    render(createElement(Harness));
    const trigger = screen.getByTestId("chat-model-select-trigger");
    expect(trigger.querySelector('[data-composer-trigger-frame="open"]')).not.toBeNull();
    fireEvent.keyDown(screen.getByRole("slider"), { key: "Escape" });
    await waitFor(() =>
      expect(trigger.querySelector('[data-composer-trigger-frame="open"]')).toBeNull(),
    );
    expect(trigger.querySelector('[data-composer-trigger-frame="closed"]')?.textContent).toContain(
      "GLM-5.3-Flash",
    );
    fireEvent.keyDown(trigger, { key: "Enter" });
    await waitFor(() =>
      expect(trigger.querySelector('[data-composer-trigger-frame="closed"]')).toBeNull(),
    );
    expect(trigger.querySelector('[data-composer-trigger-frame="open"]')?.textContent).toBe(
      "Select modelHigh",
    );

    expect(screen.getByTestId("chat-model-select-trigger")).toBe(trigger);
  });

  it("shows the configured effort shortcut and hides an unassigned binding", () => {
    const { rerender } = render(createElement(Harness, { effortShortcutLabel: "Alt+R" }));
    expect(screen.getByTestId("composer-effort-shortcut").textContent).toBe("Alt+R");
    rerender(createElement(Harness, { effortShortcutLabel: "" }));
    expect(screen.queryByTestId("composer-effort-shortcut")).toBeNull();
  });

  it("updates the rolling effort value without replacing the slider or title", async () => {
    render(createElement(Harness));
    const slider = screen.getByRole("slider");
    const title = screen.getByText("Effort");
    const value = screen.getByTestId("composer-thought-value");
    expect(value.querySelector('[title="High"]')).not.toBeNull();
    fireEvent.change(slider, { target: { value: "1" } });
    await waitFor(() => expect(value.textContent).toBe("Medium"));
    expect(value.querySelector('[title="Medium"]')).not.toBeNull();
    expect(screen.getByRole("slider")).toBe(slider);
    expect(screen.getByText("Effort")).toBe(title);
  });

  it.each(["off", "disabled", "false", "no", "none", "nothink", "no-think", "no_think"])(
    "shows sole %s as read-only text",
    (value) => {
      render(
        createElement(Harness, {
          levelsOverride: [{ value, label: "Off" }],
          initialThought: value,
        }),
      );
      expect(screen.getByText("Effort")).toBeTruthy();
      expect(screen.getByTestId("composer-thought-value").textContent).toBe("Off");
      expect(screen.queryByRole("slider")).toBeNull();
      expect(screen.queryByRole("switch")).toBeNull();
    },
  );
  it.each(["on", "enabled", "enable", "true", "high"])(
    "shows sole %s as a read-only effort value without adjustment controls",
    (value) => {
      render(
        createElement(Harness, {
          levelsOverride: [{ value, label: "On" }],
          initialThought: value,
        }),
      );
      expect(screen.getByText("Effort")).toBeTruthy();
      expect(screen.getByTestId("composer-thought-value").textContent).toBe("On");
      expect(screen.queryByRole("slider")).toBeNull();
      expect(screen.queryByRole("switch")).toBeNull();
      expect(screen.queryByTestId("composer-effort-shortcut")).toBeNull();
    },
  );
  it.each(["on", "enabled", "enable", "true"])(
    "uses original off/%s values with a discrete slider regardless of option order",
    (value) => {
      render(
        createElement(Harness, {
          levelsOverride: [
            { value, label: "On" },
            { value: "off", label: "Off" },
          ],
          initialThought: "off",
        }),
      );
      const slider = screen.getByRole("slider");
      expect(slider.getAttribute("max")).toBe("1");
      expect(screen.queryByRole("switch")).toBeNull();
      expect(slider.getAttribute("aria-valuetext")).toBe("Off");
      fireEvent.change(slider, { target: { value: "0" } });
      expect(slider.getAttribute("aria-valuetext")).toBe("On");
      expect(screen.getByRole("menu")).toBeTruthy();
      fireEvent.change(slider, { target: { value: "1" } });
      expect(slider.getAttribute("aria-valuetext")).toBe("Off");
      fireEvent.keyDown(slider, { key: "Escape" });
      expect(screen.queryByRole("menu")).toBeNull();
    },
  );
  it.each(["low", "off"])(
    "keeps %s/high as strength levels instead of a binary switch",
    (value) => {
      render(
        createElement(Harness, {
          levelsOverride: [
            { value, label: "Low" },
            { value: "high", label: "High" },
          ],
        }),
      );
      expect(screen.getByRole("slider")).toBeTruthy();
      expect(screen.queryByRole("switch")).toBeNull();
    },
  );
  it("keeps an empty selection secondary without a phantom effort or effort placeholder", () => {
    render(createElement(Harness, { empty: true }));
    const trigger = screen.getByTestId("chat-model-select-trigger");
    expect(trigger.textContent).toBe("Select model");
    expect(trigger.getAttribute("aria-label")).toBe("Select model");

    expect(screen.queryByTestId("composer-thought-meter")).toBeNull();
    fireEvent.keyDown(screen.getByRole("slider"), { key: "Escape" });
    expect(trigger.textContent).toBe("Select model");
  });
  it("keeps the native input while replacing model visuals", () => {
    render(createElement(Harness));
    const slider = screen.getByRole("slider");
    const shell = slider.parentElement!;
    const thumb = shell.querySelector(".composer-thought-slider-thumb");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "GLM-5.3", exact: true }));
    expect(screen.getByRole("slider")).toBe(slider);
    expect(
      screen.getByRole("slider").parentElement!.querySelector(".composer-thought-slider-thumb"),
    ).not.toBe(thumb);
  });
  it("shows a model selection label while open and restores selection text after closing", () => {
    render(createElement(Harness));
    const trigger = screen.getByTestId("chat-model-select-trigger");
    expect(trigger.querySelector("[data-composer-open-label]")?.textContent).toBe("Select model");

    fireEvent.change(screen.getByRole("slider"), { target: { value: "1" } });
    expect(trigger.querySelector("[data-composer-open-label]")?.textContent).toBe("Select model");
    fireEvent.keyDown(screen.getByRole("slider"), { key: "Escape" });
    expect(trigger.textContent).toContain("GLM-5.3-Flash");
    expect(trigger.textContent).toContain("Medium");
  });
  it("shows the provider logo and access badges, with management only inside the provider submenu", () => {
    const manage = vi.fn();
    render(createElement(Harness, { onManageModels: manage }));
    const trigger = screen.getByTestId("composer-provider-trigger");
    expect(trigger.querySelector("img")?.getAttribute("src")).toContain("deepseek");
    expect(trigger.textContent).toBe("Provider AIndividual");
    expect(screen.queryByText("Manage models")).toBeNull();
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    expect(
      screen.getByRole("menuitemradio", { name: "Provider A Individual", exact: true }),
    ).toBeTruthy();
    expect(screen.getAllByText("Individual")).toHaveLength(2);
    expect(screen.getByRole("menuitemradio", { name: "Provider B API", exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Manage models" }));
    expect(manage).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps model management reachable with an empty provider directory", () => {
    const manage = vi.fn();
    render(createElement(Harness, { loading: true, onManageModels: manage }));
    fireEvent.keyDown(screen.getByTestId("composer-provider-trigger"), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Manage models" }));
    expect(manage).toHaveBeenCalledOnce();
  });
  it.each(["GLM-5.3", "GLM-5.3-Flash"])(
    "stays open after choosing %s, including the current model",
    (name) => {
      render(createElement(Harness));
      expect(screen.getByLabelText("Vision")).toBeTruthy();
      const option = screen.getByTestId(
        name === "GLM-5.3" ? "chat-model-select-item-a/glm" : "chat-model-select-item-a/flash",
      );
      fireEvent.click(option);
      expect(screen.getByRole("menu")).toBeTruthy();
      expect(option.getAttribute("aria-checked")).toBe("true");
      expect(screen.getByTestId("chat-model-select-trigger").getAttribute("aria-label")).toContain(
        name,
      );
    },
  );

  it("keeps the menu open while mapping slider indices to declared levels", () => {
    render(createElement(Harness));
    const slider = screen.getByRole("slider", { name: "Effort" });
    expect(document.querySelectorAll("[data-composer-thought-stop]")).toHaveLength(3);
    expect(screen.getByTestId("composer-thought-track").getAttribute("data-progress")).toBe("100");
    expect(slider.getAttribute("aria-valuetext")).toBe("High");
    expect(
      slider
        .parentElement!.querySelector(".composer-thought-slider-fill")
        ?.getAttribute("data-max"),
    ).toBe("true");

    fireEvent.change(slider, { target: { value: "1" } });
    expect(slider.getAttribute("aria-valuetext")).toBe("Medium");
    expect(
      slider
        .parentElement!.querySelector(".composer-thought-slider-fill")
        ?.getAttribute("data-max"),
    ).toBe("false");
    expect(screen.queryByTestId("composer-thought-bubbles")).toBeNull();
    expect(screen.getByTestId("composer-thought-track").getAttribute("data-progress")).toBe("50");
    expect(screen.getByTestId("chat-model-select-trigger").getAttribute("aria-label")).toContain(
      "Medium",
    );
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("selects the provider model and synchronizes thinking without a second model click", () => {
    render(createElement(Harness));
    const providerTrigger = screen.getByTestId("composer-provider-trigger");
    fireEvent.keyDown(providerTrigger, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Provider B API" }));
    expect(screen.getByTestId("chat-model-select-trigger").getAttribute("aria-label")).toContain(
      "Fixed model",
    );
    expect(
      screen.getByRole("menuitemradio", { name: "Fixed model" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.getByText("Effort")).toBeTruthy();

    expect(screen.getByTestId("composer-thought-meter").getAttribute("data-progress")).toBe("0");
    fireEvent.keyDown(screen.getByTestId("composer-provider-trigger"), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Provider A Individual" }));
    expect(screen.getByRole("slider")).toBeTruthy();
  });

  it("preserves the selected model when selecting the current provider again", () => {
    render(createElement(Harness));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "GLM-5.3", exact: true }));
    fireEvent.keyDown(screen.getByTestId("composer-provider-trigger"), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Provider A Individual" }));
    expect(
      screen
        .getByRole("menuitemradio", { name: "GLM-5.3", exact: true })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("skips locked models when automatically selecting a provider model", () => {
    render(createElement(Harness, { locked: ["a/flash"] }));
    fireEvent.keyDown(screen.getByTestId("composer-provider-trigger"), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Provider B API" }));
    fireEvent.keyDown(screen.getByTestId("composer-provider-trigger"), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Provider A Individual" }));
    expect(
      screen
        .getByRole("menuitemradio", { name: "GLM-5.3", exact: true })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("keeps the current selection when the target provider has no available model", () => {
    render(createElement(Harness, { locked: ["b/fixed"] }));
    fireEvent.keyDown(screen.getByTestId("composer-provider-trigger"), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Provider B API" }));
    expect(screen.getByTestId("chat-model-select-trigger").getAttribute("aria-label")).toContain(
      "GLM-5.3-Flash",
    );
    expect(screen.getByRole("slider").getAttribute("aria-disabled")).toBe("true");
  });

  it("does not project an invalid effort as a selected first level", () => {
    render(createElement(Harness, { invalid: true }));
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("—");
    expect(screen.getByTestId("composer-thought-meter").getAttribute("data-progress")).toBe("0");
    fireEvent.change(screen.getByRole("slider"), { target: { value: "2" } });
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("High");
  });
  it("can explicitly select the first level with Home when the current value is missing", () => {
    render(createElement(Harness, { invalid: true }));
    fireEvent.keyUp(screen.getByRole("slider"), { key: "Home" });
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("Off");
  });
  it("retains slider focus while the same model catalog refreshes after an effort change", () => {
    const view = render(createElement(Harness));
    const slider = screen.getByRole("slider");
    slider.focus();
    view.rerender(createElement(Harness, { loading: true }));
    expect(document.activeElement).toBe(slider);
    expect(slider.getAttribute("aria-disabled")).toBe("true");
    view.rerender(createElement(Harness));
    expect(document.activeElement).toBe(slider);
    expect(slider.getAttribute("aria-disabled")).toBe("false");
  });
});

describe("narrow provider navigation", () => {
  it("returns without changing model and selects a provider in the same menu", async () => {
    const original = window.matchMedia;
    window.matchMedia = vi
      .fn()
      .mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    try {
      render(createElement(Harness));
      fireEvent.click(screen.getByTestId("composer-provider-trigger"));
      expect(screen.queryByTestId("composer-thought-slider")).toBeNull();
      fireEvent.click(screen.getByTestId("composer-provider-back"));
      expect(screen.getByTestId("composer-thought-slider")).toBeTruthy();
      fireEvent.click(screen.getByTestId("composer-provider-trigger"));
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Provider B API" }));
      await waitFor(() =>
        expect(screen.getByRole("menuitemradio", { name: "Fixed model" })).toBeTruthy(),
      );
      expect(screen.queryByTestId("composer-provider-back")).toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });
});

describe("GLM Highspeed max effort", () => {
  it.each([
    ["GLM-5.3-Highspeed", true],
    ["glm-5.3-HIGHSPEED", true],
    ["GLM-5.3-FlashX", true],
    ["glm-5.3-FLASHx", true],
    ["FlashX", false],
    ["DeepSeek-FlashX", false],
    ["GLM-5.3", false],
    ["DeepSeek-Highspeed", false],
  ])("derives the effect from model name %s", (modelName, enabled) => {
    render(createElement(Harness, { modelName }));

    expect(screen.getByTestId("composer-thought-meter").getAttribute("data-highspeed")).toBe(
      String(enabled),
    );

    expect(
      document.querySelector(".composer-thought-slider-fill")?.getAttribute("data-highspeed"),
    ).toBe(String(enabled));
    fireEvent.change(screen.getByRole("slider"), { target: { value: "1" } });
    expect(screen.queryByTestId("composer-thought-bubbles")).toBeNull();
    expect(document.querySelector(".composer-thought-slider-fill")?.getAttribute("data-max")).toBe(
      "false",
    );
    fireEvent.click(screen.getAllByRole("menuitemradio", { name: "GLM-5.3", exact: true }).at(-1)!);
    expect(
      document.querySelector(".composer-thought-slider-fill")?.getAttribute("data-highspeed"),
    ).toBe("false");
  });
});

it("hides the effort area when a selected model has no effort capability", () => {
  render(createElement(Harness, { levelsOverride: [] }));
  expect(screen.getByRole("menuitemradio", { name: "GLM-5.3", exact: true })).toBeTruthy();
  expect(screen.queryByText("Effort")).toBeNull();
  expect(screen.queryByRole("slider")).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
});
