// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecuteOutput } from "@/ToolCallBlocks/renderers/ExecuteOutput.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function view(text: string, running = true) {
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: "zh-CN" },
    createElement(ExecuteOutput, { text, running }),
  );
}

function geometry() {
  let height = 500;
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => height);
  return (value: number) => {
    height = value;
  };
}

describe("foreground Bash output following", () => {
  it("keeps an already completed history result at its head", () => {
    geometry();
    const screen = render(view("historical summary", false));
    expect(screen.getByTestId("bash-output-scroll").scrollTop).toBe(0);
    expect(screen.queryByTestId("bash-output-resume")).toBeNull();
  });

  it("follows each new window and content shrink without mistaking program scroll for user input", () => {
    const resize = geometry();
    const screen = render(view("first"));
    const scroll = screen.getByTestId("bash-output-scroll");
    expect(scroll.scrollTop).toBe(500);
    resize(800);
    screen.rerender(view("second"));
    expect(scroll.scrollTop).toBe(800);
    resize(100);
    screen.rerender(view("short"));
    scroll.scrollTop = 0;
    fireEvent.scroll(scroll);
    expect(screen.queryByTestId("bash-output-resume")).toBeNull();
    resize(600);
    screen.rerender(view("latest"));
    expect(scroll.scrollTop).toBe(600);
  });

  it("freezes user reading across updates and completion, then resumes by scrolling to the bottom", () => {
    geometry();
    const screen = render(view("reading"));
    const scroll = screen.getByTestId("bash-output-scroll");
    scroll.scrollTop = 40;
    fireEvent.scroll(scroll);
    expect(scroll.dataset.following).toBe("false");
    expect(screen.queryByTestId("bash-output-resume")).toBeNull();
    screen.rerender(view("new tail"));
    expect(scroll.textContent).toBe("reading");
    expect(scroll.scrollTop).toBe(40);
    scroll.scrollTop = 200;
    fireEvent.scroll(scroll);
    expect(scroll.dataset.following).toBe("false");
    expect(scroll.textContent).toBe("reading");
    screen.rerender(view("final summary", false));
    expect(scroll.textContent).toBe("reading");
    expect(scroll.contains(screen.getByTestId("bash-result-output"))).toBe(true);
    scroll.scrollTop = 400;
    fireEvent.scroll(scroll);
    expect(scroll.dataset.following).toBe("true");
    expect(scroll.textContent).toBe("final summary");
    expect(scroll.scrollTop).toBe(500);
  });

  it("does not share pause state with another execution or a reopened detail", () => {
    geometry();
    const first = render(view("first"));
    const scroll = first.getByTestId("bash-output-scroll");
    scroll.scrollTop = 20;
    fireEvent.scroll(scroll);
    first.unmount();
    const reopened = render(view("latest"));
    expect(reopened.queryByTestId("bash-output-resume")).toBeNull();
    expect(reopened.getByTestId("bash-output-scroll").scrollTop).toBe(500);
  });

});
