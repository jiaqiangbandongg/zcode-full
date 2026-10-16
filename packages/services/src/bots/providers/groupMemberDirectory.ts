export interface GroupMemberPage {
  items?: Array<{ member_id?: string; name?: string }>;
  has_more?: boolean;
  page_token?: string;
}

export function createGroupMemberDirectory(now: () => number = Date.now) {
  const cache = new Map<string, { expires: number; value: Promise<Record<string, string>> }>();
  return (
    key: string,
    readPage: (cursor?: string) => Promise<GroupMemberPage>,
  ): Promise<Record<string, string>> => {
    const existing = cache.get(key);
    if (existing && existing.expires > now()) return existing.value;
    const entry = { expires: Infinity, value: Promise.resolve({} as Record<string, string>) };
    entry.value = (async () => {
      try {
        const names: Record<string, string> = Object.create(null);
        const visited = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await readPage(cursor);
          for (const member of page.items ?? []) {
            if (member.member_id?.startsWith("ou_") && member.name?.trim()) {
              names[member.member_id] = member.name.trim();
            }
          }
          if (!page.has_more) break;
          cursor = page.page_token;
          if (!cursor || visited.has(cursor)) throw new Error("Invalid group member pagination");
          visited.add(cursor);
        } while (cursor);
        entry.expires = now() + 60_000;
        return names;
      } catch (error) {
        // 缺少权限时短暂缓存失败，避免每条群消息重复查询；不暴露不完整的分页结果。
        entry.expires = now() + 30_000;
        throw error;
      }
    })();
    cache.delete(key);
    cache.set(key, entry);
    if (cache.size > 128) cache.delete(cache.keys().next().value!);
    return entry.value;
  };
}
