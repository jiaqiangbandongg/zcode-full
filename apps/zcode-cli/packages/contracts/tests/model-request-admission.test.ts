import { describe, expect, it } from "vitest";
import {
  modelTextRequestJsonSchema,
  type ModelNetworkStatusEvent,
  type ModelRequestAdmission,
  type ModelRequestAdmissionTicket,
  type ModelTextRequest,
} from "../src/model/index.js";

// docs/dynamic-workflow/concurrency.md「One ticket per request attempt」：准入端口是 runtime-only 请求字段；票据同时是
// 该次尝试的状态事件汇（extends ModelStatusSink）。
describe("ModelRequestAdmission", () => {
  it("is a runtime-only request field and stays out of the model request JSON schema", () => {
    const received: ModelNetworkStatusEvent[] = [];
    let released = 0;
    const ticket: ModelRequestAdmissionTicket = {
      publish(event) {
        received.push(event);
      },
      release() {
        released += 1;
      },
    };
    const admission: ModelRequestAdmission = {
      async acquire() {
        return ticket;
      },
    };
    const request: ModelTextRequest = {
      model: "test/model",
      messages: [],
      modelRequestAdmission: admission,
    };
    expect(request.modelRequestAdmission).toBe(admission);
    const properties = (modelTextRequestJsonSchema as { properties: Record<string, unknown> })
      .properties;
    expect(properties).not.toHaveProperty("modelRequestAdmission");
    ticket.release();
    expect(released).toBe(1);
    expect(received).toEqual([]);
  });
});
