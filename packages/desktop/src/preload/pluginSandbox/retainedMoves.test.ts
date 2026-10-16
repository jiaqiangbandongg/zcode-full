import { afterEach, describe, expect, it, vi } from "vitest";
import { enableSandboxRetainedMoves } from "./retainedMoves.js";

afterEach(() => vi.unstubAllGlobals());
describe("sandbox retained moves", () => {
  it("preserves only opted-in webviews and restores customElements.define", () => {
    const connected = vi.fn(),
      disconnected = vi.fn();
    class ElementStub {
      moveBefore() {}
    }
    class Webview extends ElementStub {
      retained = true;
      hasAttribute() {
        return this.retained;
      }
      connectedCallback = connected;
      disconnectedCallback = disconnected;
    }
    Object.assign(Webview.prototype, {
      connectedCallback: connected,
      disconnectedCallback: disconnected,
    });
    const define = vi.fn();
    vi.stubGlobal("Element", ElementStub);
    vi.stubGlobal("customElements", { define });
    expect(enableSandboxRetainedMoves()).toBe(true);
    customElements.define("webview", Webview as unknown as CustomElementConstructor);
    expect(customElements.define).toBe(define);
    const page = new Webview();
    const move = (Webview.prototype as unknown as { connectedMoveCallback(): void })
      .connectedMoveCallback;
    move.call(page);
    expect(disconnected).not.toHaveBeenCalled();
    page.retained = false;
    move.call(page);
    expect(disconnected).toHaveBeenCalledOnce();
    expect(connected).toHaveBeenCalledOnce();
    page.disconnectedCallback();
    expect(disconnected).toHaveBeenCalledTimes(2);
  });
});
