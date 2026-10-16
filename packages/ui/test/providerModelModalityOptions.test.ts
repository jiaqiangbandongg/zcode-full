// @vitest-environment jsdom

import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderModelInputModalityOptions } from "@/settings/model-provider-section/ProviderModelModalityOptions.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id.split(".").at(-1)?.toUpperCase() ?? id,
    },
  }),
}));

afterEach(cleanup);

describe("ProviderModelInputModalityOptions", () => {
  it("展示并切换 PDF，同时不暴露尚未开放的 Audio", () => {
    function Harness() {
      const [value, setValue] = useState({
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: true,
        supportsPdf: false,
      });
      return createElement(ProviderModelInputModalityOptions, { value, onChange: setValue });
    }

    const { container } = render(createElement(Harness));

    expect(container.querySelector('[data-model-input-modality="audio"]')).toBeNull();
    const pdf = screen.getByRole("button", { name: "PDF" });
    expect(pdf.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(pdf);

    expect(pdf.getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("button", { name: "TEXT" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
