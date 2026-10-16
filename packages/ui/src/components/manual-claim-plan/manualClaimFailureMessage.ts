import { requestVerificationClaimFailureMessageId } from "@/request-security-edition/errors.js";
export function resolveManualClaimFailureMessageId(
  code: number,
  failureEndsAt?: number,
  now = Date.now(),
): string {
  switch (code) {
    case 1001:
      return "manualClaimPlan.claim.failure.notFound";
    case 1002:
      return "manualClaimPlan.claim.failure.unavailable";
    case 1003:
      return "manualClaimPlan.claim.failure.alreadyClaimed";
    case 1004:
      return "manualClaimPlan.claim.failure.ineligible";
    case 1005: {
      if (typeof failureEndsAt !== "number" || !Number.isFinite(failureEndsAt)) {
        return "manualClaimPlan.claim.failure.quotaExhausted";
      }
      const endsAtDate = new Date(failureEndsAt * 1_000);
      const nowDate = new Date(now);
      const endsAtDay = new Date(
        endsAtDate.getFullYear(),
        endsAtDate.getMonth(),
        endsAtDate.getDate(),
      ).getTime();
      const today = new Date(
        nowDate.getFullYear(),
        nowDate.getMonth(),
        nowDate.getDate(),
      ).getTime();
      return endsAtDay <= today
        ? "manualClaimPlan.claim.failure.quotaExhausted.nextTime"
        : "manualClaimPlan.claim.failure.quotaExhausted.tomorrow";
    }
    case 3001:
      return "manualClaimPlan.claim.failure.invalidRequest";
    case 3007:
      return requestVerificationClaimFailureMessageId;
    case 401:
      return "manualClaimPlan.claim.failure.loginRequired";
    default:
      return "manualClaimPlan.claim.failure.generic";
  }
}
