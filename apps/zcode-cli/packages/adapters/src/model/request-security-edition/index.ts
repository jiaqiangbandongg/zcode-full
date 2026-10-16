import type { ModelRequestSecurityState } from "../request-security.js";

export function createModelRequestSecurityState(): ModelRequestSecurityState {
  return {
    createExecution: () => ({
      protectTransport: ({ transport }) => transport,
      take: () => [],
    }),
  };
}
