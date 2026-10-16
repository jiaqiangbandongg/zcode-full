describe("桌面端 E2E session 生命周期", () => {
  it("每轮都把 WebDriver current handle 绑定到真实 renderer page target", async () => {
    const handles = await browser.getWindowHandles();
    const currentHandle = await browser.getWindowHandle();
    const puppeteer = await browser.getPuppeteer();
    const pageTargetIds = puppeteer
      .targets()
      .filter((target) => target.type() === "page")
      .map((target) => (target as unknown as { _targetId?: string })._targetId)
      .filter((targetId): targetId is string => Boolean(targetId));
    const url = await browser.execute(() => window.location.href);

    expect(handles).toContain(currentHandle);
    expect(pageTargetIds).toContain(currentHandle);
    expect(handles.every((handle) => pageTargetIds.includes(handle))).toBe(true);
    expect(url).toContain("/renderer/index.html");
    expect(url).not.toBe("chrome-error://chromewebdata/");
  });
});
