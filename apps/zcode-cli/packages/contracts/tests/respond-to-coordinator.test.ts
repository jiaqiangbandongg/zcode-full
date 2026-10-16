import { describe, expect, it } from "vitest";
import {
  RESPOND_TO_COORDINATOR_MAX_CONTENT_CHARS,
  RespondToCoordinatorInputSchema,
  RespondToCoordinatorOutputSchema,
} from "../src/index.js";

describe("RespondToCoordinator contract", () => {
  it("accepts only summary and message as provider input", () => {
    expect(
      RespondToCoordinatorInputSchema.parse({
        summary: "进度更新",
        message: "已完成入口定位，正在验证异常路径。",
      }),
    ).toEqual({
      summary: "进度更新",
      message: "已完成入口定位，正在验证异常路径。",
    });

    for (const routingField of ["to", "agentId", "childSessionId", "parentSessionId"]) {
      expect(() =>
        RespondToCoordinatorInputSchema.parse({
          summary: "进度更新",
          message: "继续检查。",
          [routingField]: "model_supplied_route",
        }),
      ).toThrow();
    }
  });

  it("enforces summary and message content limits", () => {
    expect(() => RespondToCoordinatorInputSchema.parse({ summary: "", message: "x" })).toThrow();
    expect(
      RespondToCoordinatorInputSchema.parse({
        summary: "x",
        message: "x".repeat(RESPOND_TO_COORDINATOR_MAX_CONTENT_CHARS),
      }).message,
    ).toHaveLength(RESPOND_TO_COORDINATOR_MAX_CONTENT_CHARS);
    expect(() =>
      RespondToCoordinatorInputSchema.parse({
        summary: "x",
        message: "x".repeat(RESPOND_TO_COORDINATOR_MAX_CONTENT_CHARS + 1),
      }),
    ).toThrow();
  });

  it("rejects provider-private routing fields in runtime output", () => {
    expect(
      RespondToCoordinatorOutputSchema.parse({
        status: "success",
        responseId: "response_1",
        message: "Response queued for the coordinator.",
      }),
    ).toMatchObject({ status: "success", responseId: "response_1" });

    for (const routingField of ["agentId", "childSessionId", "parentSessionId", "to"]) {
      expect(() =>
        RespondToCoordinatorOutputSchema.parse({
          status: "success",
          responseId: "response_1",
          message: "Response queued for the coordinator.",
          [routingField]: "model_supplied_route",
        }),
      ).toThrow();
    }
  });
});
