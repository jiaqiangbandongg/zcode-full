import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveShareHeaderView } from "../src/share/shareHeaderLayout.js";

const landingPageCss = readFileSync(
  fileURLToPath(new URL("../src/share/conversationShareLandingPage.css", import.meta.url)),
  "utf8",
);

describe("share header continuous layout", () => {
  const base = {
    shellWidth: 1200,
    railContentLeft: 220,
    railContentRight: 220,
    brandWidth: 50,
    titleContentWidth: 500,
    continueWidth: 153,
    gap: 16,
  };

  it("keeps the wide anchors while both gutters have enough room", () => {
    const view = resolveShareHeaderView(base);

    expect(view.progress).toBe(1);
    expect(view.brandLeft).toBe(24);
    expect(view.titleLeft).toBe(220);
    expect(view.continueRight).toBe(24);
    expect(view.continueVisible).toBe(true);
    expect(view.titleWidth).toBe(760);
    expect(view.titleTruncated).toBe(false);
  });

  it("only starts left-side compression after the left gutter is insufficient", () => {
    const wide = resolveShareHeaderView({ ...base, railContentLeft: 220, railContentRight: 220 });
    const insufficient = resolveShareHeaderView({
      ...base,
      railContentLeft: 45,
      railContentRight: 220,
    });
    const narrow = resolveShareHeaderView({ ...base, railContentLeft: 20, railContentRight: 220 });

    expect(wide.brandLeft).toBe(24);
    expect(insufficient.brandLeft).toBeGreaterThan(wide.brandLeft);
    expect(insufficient.brandLeft).toBeGreaterThan(narrow.brandLeft);
    expect(insufficient.continueRight).toBe(wide.continueRight);
  });

  it("only starts right-side compression after the right gutter is insufficient", () => {
    const wide = resolveShareHeaderView({ ...base, railContentLeft: 220, railContentRight: 220 });
    const insufficient = resolveShareHeaderView({
      ...base,
      railContentLeft: 220,
      railContentRight: 96,
    });
    const narrow = resolveShareHeaderView({ ...base, railContentLeft: 220, railContentRight: 20 });

    expect(wide.continueRight).toBe(24);
    expect(insufficient.continueRight).toBeGreaterThan(wide.continueRight);
    expect(insufficient.continueRight).toBeGreaterThan(narrow.continueRight);
    expect(insufficient.brandLeft).toBe(wide.brandLeft);
  });

  it("does not reserve a CTA when the share is readonly", () => {
    const view = resolveShareHeaderView({
      ...base,
      continueWidth: 0,
      railContentLeft: 220,
      railContentRight: 220,
    });

    expect(view.progress).toBe(1);
    expect(view.continueVisible).toBe(false);
    expect(view.continueRight).toBe(24);
    expect(view.titleWidth).toBe(760);
  });

  it("keeps the title and CTA separated at every progress value", () => {
    for (let gutter = 0; gutter <= 700; gutter += 1) {
      const view = resolveShareHeaderView({
        ...base,
        railContentLeft: gutter,
        railContentRight: gutter,
      });
      const continueLeft = base.shellWidth - view.continueRight - base.continueWidth;

      expect(view.titleLeft + view.titleWidth).toBeLessThanOrEqual(continueLeft - base.gap + 1e-8);
      expect(view.titleWidth).toBeGreaterThanOrEqual(0);
    }
  });

  it("accounts for locale-dependent CTA width without a fixed breakpoint", () => {
    const chinese = resolveShareHeaderView({
      ...base,
      continueWidth: 153,
      railContentLeft: 250,
      railContentRight: 250,
    });
    const english = resolveShareHeaderView({
      ...base,
      continueWidth: 260,
      railContentLeft: 250,
      railContentRight: 250,
    });

    expect(chinese.progress).toBeGreaterThan(english.progress);
    expect(chinese.continueVisible).toBe(true);
    expect(english.continueVisible).toBe(true);
  });

  it("compacts the CTA before a narrow shell collapses the share title", () => {
    const view = resolveShareHeaderView({
      ...base,
      shellWidth: 320,
      railContentLeft: 16,
      railContentRight: 16,
      continueWidth: 201,
      compactContinueWidth: 76,
      hasContinueAction: true,
    });

    expect(view.continueVisible).toBe(true);
    expect(view.continueCompact).toBe(true);
    expect(view.titleWidth).toBeGreaterThanOrEqual(80);
  });

  it("does not mark the theme-only readonly trailing slot as a compact CTA", () => {
    const view = resolveShareHeaderView({
      ...base,
      continueWidth: 32,
      compactContinueWidth: 32,
      hasContinueAction: false,
    });

    expect(view.continueVisible).toBe(false);
    expect(view.continueCompact).toBe(false);
  });

  it("uses one fixed-height continuous shell instead of binary layout selectors", () => {
    expect(landingPageCss).toContain('[data-share-header-shell="true"]');
    expect(landingPageCss).toContain('[data-share-header-row="true"]');
    expect(landingPageCss).toContain("text-overflow: ellipsis");
    expect(landingPageCss).toContain("white-space: nowrap");
    expect(landingPageCss).toContain("--share-brand-left");
    expect(landingPageCss).toContain("--share-title-width");
    expect(landingPageCss).toContain("--share-continue-right");
    expect(landingPageCss).not.toContain('data-share-header-layout="compact"');
    expect(landingPageCss).not.toContain("min-height: 8rem");
  });
});
