// 新源码原来散落在 legacy 根目录，CI 无法确认归属；公开入口统一收口到受管模块。
export * from "#src/web-remote-relay/contract.js";
export * from "#src/web-remote-relay/domain/retry.js";
export * from "#src/web-remote-relay/domain/heartbeatTiming.js";
export { WebRemoteControlV2Heartbeat } from "#src/web-remote-relay/adapters/heartbeat.js";
