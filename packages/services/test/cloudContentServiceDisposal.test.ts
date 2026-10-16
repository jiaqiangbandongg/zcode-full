import { describe, expect, it, vi } from "vitest";
import { ServiceCollection } from "../src/collection.js";
import { ICloudContentService } from "../src/cloud-content/cloudContent.js";
import { disposeServiceResources, disposeServiceResourcesAndWait } from "../src/node.js";

describe("cloud content host disposal", () => {
  it("waits for async-only resource disposal before allowing the host to exit", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const disposeAllAndWait = vi.fn(() => gate);
    const service = {
      prepare: vi.fn(),
      release: vi.fn(),
      readPublishedMedia: vi.fn(),
      disposeAllAndWait,
    };
    const services = new ServiceCollection().register(ICloudContentService, service);
    let finished = false;
    const closing = disposeServiceResourcesAndWait(services).then(() => {
      finished = true;
    });
    try {
      await Promise.resolve();
      expect(disposeAllAndWait).toHaveBeenCalledTimes(1);
      expect(finished).toBe(false);
    } finally {
      release();
      await closing;
    }
    expect(finished).toBe(true);
  });

  it("also starts async-only disposal from the synchronous best-effort shutdown path", async () => {
    const disposeAllAndWait = vi.fn(async () => {
      throw new Error("E2E disposal failure");
    });
    const service = {
      prepare: vi.fn(),
      release: vi.fn(),
      readPublishedMedia: vi.fn(),
      disposeAllAndWait,
    };
    disposeServiceResources(new ServiceCollection().register(ICloudContentService, service));
    await Promise.resolve();
    expect(disposeAllAndWait).toHaveBeenCalledTimes(1);
  });
});
