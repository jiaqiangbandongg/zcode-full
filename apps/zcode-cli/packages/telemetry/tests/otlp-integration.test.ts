import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { opentelemetry } from "@opentelemetry/otlp-transformer/build/src/generated/root.js";
import { afterEach, describe, expect, it } from "vitest";
import { createOwnedAgentTelemetryRuntime } from "../src/otlp-exporter.js";

let closeOwner: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeOwner?.();
  closeOwner = undefined;
});

describe("ARMS-compatible OTLP/HTTP V4", () => {
  it("gzip 批量上报真实 Trace，并携带三条独立版本轴和写入 Header", async () => {
    const requests: Array<{
      body: Buffer;
      headers: Record<string, string | string[] | undefined>;
      url: string;
    }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        requests.push({
          body: Buffer.concat(chunks),
          headers: request.headers,
          url: request.url ?? "",
        });
        response.writeHead(200);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");

    const owner = createOwnedAgentTelemetryRuntime({
      endpoint: `http://127.0.0.1:${address.port}/v1/traces`,
      headers: { "x-arms-license-key": "write-only-test" },
      metricEndpoint: `http://127.0.0.1:${address.port}/v1/metrics`,
      // 集成测试需要稳定拿到完整 Trace；生产默认采样率由独立配置测试覆盖。
      traceSampleRatio: 1,
      resource: {
        buildCommitId: "abcdef1234567",
        cliVersion: "0.16.1",
        installationId: "installation-1",
        productVersion: "3.6.1",
        runtimeDistribution: "packaged",
        runtimeSurface: "desktop_local_host",
        serviceInstanceId: "instance-1",
        serviceName: "zcode-cli-agent",
      },
    });
    closeOwner = async () => {
      await owner.shutdown();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    };

    const turn = owner.agentExecution.startTurn({
      context: {
        actorKind: "main",
        launchSurface: "desktop",
        sessionId: "session-1",
        turnId: "turn-1",
      },
      turnNumber: 1,
    });
    await turn.run(async () => {
      const step = owner.agentExecution.startStep({ stepId: "step-1", stepIndex: 0 });
      await step.run(async () => {
        const call = owner.modelExecution.startCall({
          logicalCallId: "logical-1",
          operation: "agent_step",
          requested: {
            providerId: "anthropic-prod",
            reasoning: {
              capability: "supported",
              effectiveControl: "fixed_level",
              effectiveState: "enabled",
              requestedControl: "fixed_level",
              requestedState: "enabled",
            },
            requestedModel: "claude-test",
          },
          streaming: true,
        });
        await call.run(async () => {
          const attempt = call.startAttempt({
            apiOperation: "messages",
            attemptCause: "initial",
            attemptNumber: 1,
            requestId: "request-1",
            target: {
              providerId: "anthropic-prod",
              providerKind: "anthropic",
              reasoning: {
                capability: "supported",
                effectiveControl: "fixed_level",
                effectiveState: "enabled",
                requestedControl: "fixed_level",
                requestedState: "enabled",
              },
              requestedModel: "claude-test",
            },
            transport: "sse",
          });
          await attempt.run(async () => {
            attempt.markFirstContent();
            attempt.setInputTokens(12);
            attempt.setOutputTokens(4);
            attempt.finishCompleted();
          });
          call.finishCompleted();
        });
        step.finishCompleted("model_completed");
      });
      turn.finishCompleted("assistant_message");
    });
    await owner.flush({ timeoutMs: 3_000 });

    expect(requests).toHaveLength(2);
    const traceRequest = requests.find((request) => request.url === "/v1/traces");
    const metricRequest = requests.find((request) => request.url === "/v1/metrics");
    expect(traceRequest?.headers["x-arms-license-key"]).toBe("write-only-test");
    expect(traceRequest?.headers["content-encoding"]).toBe("gzip");
    const decoded = opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest.decode(
      gunzipSync(traceRequest!.body),
    );
    const resource = decoded.resourceSpans[0]?.resource?.attributes ?? [];
    const attributes = Object.fromEntries(
      resource.map((attribute) => [
        attribute.key,
        attribute.value?.stringValue ??
          (attribute.value?.intValue !== undefined
            ? Number(attribute.value.intValue)
            : undefined) ??
          attribute.value?.boolValue,
      ]),
    );
    expect(attributes).toMatchObject({
      "service.name": "zcode-cli-agent",
      "service.version": "0.16.1",
      "zcode.device.installation_id": "installation-1",
      "zcode.product.version": "3.6.1",
      "zcode.telemetry.schema_owner": "cli",
      "zcode.telemetry.schema_version": 6,
    });
    const spanNames = decoded.resourceSpans
      .flatMap((item) => item.scopeSpans)
      .flatMap((item) => item.spans)
      .map((item) => item.name);
    expect(spanNames).toEqual(expect.arrayContaining(["agent_turn", "agent_step"]));

    expect(metricRequest?.headers["x-arms-license-key"]).toBe("write-only-test");
    expect(metricRequest?.headers["content-encoding"]).toBe("gzip");
    const decodedMetrics =
      opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest.decode(
        gunzipSync(metricRequest!.body),
      );
    const metricResource = decodedMetrics.resourceMetrics[0]?.resource?.attributes ?? [];
    const metricResourceAttributes = Object.fromEntries(
      metricResource.map((attribute) => [
        attribute.key,
        attribute.value?.stringValue ??
          (attribute.value?.intValue !== undefined
            ? Number(attribute.value.intValue)
            : undefined) ??
          attribute.value?.boolValue,
      ]),
    );
    expect(metricResourceAttributes).toMatchObject({
      "service.name": "zcode-cli-agent",
      "service.version": "0.16.1",
      "zcode.product.version": "3.6.1",
      "zcode.telemetry.schema_version": 6,
    });
    expect(metricResourceAttributes["zcode.device.installation_id"]).toBeUndefined();
    expect(metricResourceAttributes["service.instance.id"]).toBeUndefined();
    const metricNames = decodedMetrics.resourceMetrics
      .flatMap((item) => item.scopeMetrics)
      .flatMap((item) => item.metrics)
      .map((item) => item.name);
    expect(metricNames).toEqual(
      expect.arrayContaining([
        "zcode.agent.turn.duration",
        "zcode.agent.step.duration",
        "zcode.model.attempt.duration",
        "zcode.model.attempt.time_to_first_content",
        "zcode.model.attempt.tokens",
        "zcode.model.call.attempts",
        "zcode.model.call.duration",
      ]),
    );
    const metricAttributeKeys = decodedMetrics.resourceMetrics
      .flatMap((item) => item.scopeMetrics)
      .flatMap((item) => item.metrics)
      .flatMap((metric) => [
        ...(metric.gauge?.dataPoints ?? []),
        ...(metric.histogram?.dataPoints ?? []),
        ...(metric.sum?.dataPoints ?? []),
      ])
      .flatMap((point) => point.attributes.map((attribute) => attribute.key));
    expect(metricAttributeKeys).not.toEqual(
      expect.arrayContaining([
        "zcode.device.installation_id",
        "zcode.execution.session_id",
        "zcode.execution.turn_id",
        "zcode.model_attempt.request_id",
      ]),
    );
  });

  it("Trace 未采样时仍完整导出 Metric", async () => {
    const requestUrls: string[] = [];
    const server = createServer((request, response) => {
      request.on("data", () => undefined);
      request.on("end", () => {
        requestUrls.push(request.url ?? "");
        response.writeHead(200);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");

    const owner = createOwnedAgentTelemetryRuntime({
      endpoint: `http://127.0.0.1:${address.port}/v1/traces`,
      metricEndpoint: `http://127.0.0.1:${address.port}/v1/metrics`,
      resource: {
        cliVersion: "0.16.1",
        productVersion: "3.6.1",
        runtimeDistribution: "packaged",
        runtimeSurface: "desktop_local_host",
        serviceInstanceId: "instance-unsampled",
        serviceName: "zcode-cli-agent",
      },
      traceSampleRatio: 0,
    });
    closeOwner = async () => {
      await owner.shutdown();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    };

    const turn = owner.agentExecution.startTurn({
      context: {
        actorKind: "main",
        launchSurface: "desktop",
        sessionId: "session-unsampled",
        turnId: "turn-unsampled",
      },
      turnNumber: 1,
    });
    turn.finishCompleted("assistant_message");
    await owner.flush({ timeoutMs: 3_000 });

    expect(requestUrls).toEqual(["/v1/metrics"]);
  });
});
