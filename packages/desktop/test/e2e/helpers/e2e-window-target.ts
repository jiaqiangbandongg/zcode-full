export interface E2EBrowserTargetInfo {
  id: string | null;
  type: string;
  url: string;
}

export interface E2EWebDriverPageHandleCandidate {
  handle: string;
  targetUrl: string;
}

export function collectE2EWebDriverPageHandleCandidates(
  handles: string[],
  targets: E2EBrowserTargetInfo[],
): E2EWebDriverPageHandleCandidate[] {
  const pageTargetsById = new Map(
    targets
      .filter(
        (target): target is E2EBrowserTargetInfo & { id: string } =>
          target.type === "page" && typeof target.id === "string" && target.id.length > 0,
      )
      .map((target) => [target.id, target] as const),
  );

  // 修复原因：CDP targetId 只有同时出现在 ChromeDriver 的 handle 表中时，
  // 才能作为 WebDriver 窗口使用；直接把 Puppeteer targetId 传给 switchToWindow
  // 会在长批次 target 表失步时静默留在 chrome-error app target。
  return handles.flatMap((handle) => {
    const target = pageTargetsById.get(handle);
    return target ? [{ handle, targetUrl: target.url }] : [];
  });
}
