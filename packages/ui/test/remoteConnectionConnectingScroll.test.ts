import { describe, expect, it } from "vitest";
import {
  isRemoteConnectionLogScrolledToLatest,
  scrollRemoteConnectionLogsToLatestIfFollowing,
} from "@/remote-connection/remoteConnectionLogScroll.js";

function createViewport(overrides: {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}) {
  return { ...overrides };
}

describe("remote connection log scroll", () => {
  it("treats the log viewport as following latest when it is at the bottom", () => {
    const viewport = createViewport({
      clientHeight: 100,
      scrollHeight: 300,
      scrollTop: 200,
    });

    expect(isRemoteConnectionLogScrolledToLatest(viewport)).toBe(true);
  });

  it("treats the log viewport as not following latest after the user scrolls upward", () => {
    const viewport = createViewport({
      clientHeight: 100,
      scrollHeight: 300,
      scrollTop: 120,
    });

    expect(isRemoteConnectionLogScrolledToLatest(viewport)).toBe(false);
  });

  it("keeps the latest log visible when the viewport was following the bottom before an update", () => {
    const viewport = createViewport({
      clientHeight: 100,
      scrollHeight: 420,
      scrollTop: 200,
    });

    scrollRemoteConnectionLogsToLatestIfFollowing(viewport, true);

    expect(viewport.scrollTop).toBe(420);
  });

  it("preserves the manual reading position when the user has scrolled upward", () => {
    const viewport = createViewport({
      clientHeight: 100,
      scrollHeight: 420,
      scrollTop: 120,
    });

    scrollRemoteConnectionLogsToLatestIfFollowing(viewport, false);

    expect(viewport.scrollTop).toBe(120);
  });
});
