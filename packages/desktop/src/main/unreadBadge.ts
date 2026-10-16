type AppBadgeSetter = (count: number) => void;

export function parseWindowUnreadCount(payload: unknown): number | null {
  if (typeof payload !== "number" || !Number.isInteger(payload) || payload < 0) {
    return null;
  }

  return payload;
}

export function sumWindowUnreadCounts(windowUnreadCountMap: ReadonlyMap<number, number>): number {
  let totalUnreadCount = 0;

  for (const unreadCount of windowUnreadCountMap.values()) {
    totalUnreadCount += unreadCount;
  }

  return totalUnreadCount;
}

export function supportsAppUnreadBadge(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

export function syncAppUnreadBadge(options: {
  platform: NodeJS.Platform;
  totalUnreadCount: number;
  setBadgeCount: AppBadgeSetter;
}): void {
  if (!supportsAppUnreadBadge(options.platform)) {
    return;
  }

  options.setBadgeCount(options.totalUnreadCount);
}
