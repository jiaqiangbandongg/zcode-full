export function createCloudContentMockServer(options?: { port?: number }): Promise<{
  url: string;
  requests: string[];
  close: () => Promise<void>;
}>;
