import { describe, expect, it } from "vitest";
import { parseGoalCompletionVerificationText } from "../src/tools/target.js";

describe("goal target contracts", () => {
  it("parses completion verification from fenced json responses", () => {
    expect(
      parseGoalCompletionVerificationText(
        '```json\n{"nextAction":"Run pnpm test","passed":false,"reason":"Missing evidence"}\n```',
      ),
    ).toEqual({
      nextAction: "Run pnpm test",
      passed: false,
      reason: "Missing evidence",
    });
  });

  it("parses completion verification when a fenced response is json-string encoded", () => {
    expect(
      parseGoalCompletionVerificationText(
        JSON.stringify(
          '```json\n{"nextAction":"","passed":true,"reason":"All requirements are complete."}\n```',
        ),
      ),
    ).toEqual({
      passed: true,
      reason: "All requirements are complete.",
    });
  });

  it("treats malformed verifier json as passed fail-open", () => {
    expect(
      parseGoalCompletionVerificationText(
        '```json\n{"passed": true, "reason": "目标"继续修环境和做完所有开发"已全部完成。", "nextAction": ""}\n```',
      ),
    ).toEqual({
      passed: true,
      reason: "The completion verifier did not return valid JSON.",
    });
  });

  it("treats non-json verifier text as passed fail-open", () => {
    expect(parseGoalCompletionVerificationText("done")).toEqual({
      passed: true,
      reason: "The completion verifier did not return valid JSON.",
    });
  });
});
