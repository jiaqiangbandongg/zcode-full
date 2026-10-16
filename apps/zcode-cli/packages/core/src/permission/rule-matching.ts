export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

export function domainRuleSubject(url: string): string | undefined {
  try {
    const parsed = new URL(url.trim());
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    return hostname.length > 0 ? `domain:${hostname}` : undefined;
  } catch {
    return undefined;
  }
}

export function webFetchRuleSubjects(url: string): string[] {
  const domain = domainRuleSubject(url);
  return domain ? [domain] : [];
}
