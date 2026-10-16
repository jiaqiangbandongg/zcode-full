export interface DesktopTelemetryFetchSource {
  fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>;
}

export function createDesktopTelemetryFetch(source: DesktopTelemetryFetchSource): typeof fetch {
  return (input, init) => source.fetch(input, init);
}
