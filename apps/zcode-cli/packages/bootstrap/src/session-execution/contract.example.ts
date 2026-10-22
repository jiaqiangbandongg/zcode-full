import type { SessionExecutionContract, SessionResidencyFinalizationOwner } from "./contract.js";

/** 使用现有 record；不把租约当作 busy/idle 或命令准入依据。 */
export function finalizeSession<T>(
  contract: SessionExecutionContract,
  record: SessionResidencyFinalizationOwner,
  finalize: () => Promise<T>,
) {
  return contract.runWithSessionResidencyFinalization(record, finalize);
}
