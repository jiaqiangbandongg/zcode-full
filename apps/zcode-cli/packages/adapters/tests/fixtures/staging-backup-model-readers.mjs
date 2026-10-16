// 冻结旧版实际 Reader（esbuild 移除类型/打包实际调用依赖），来源 790884b1ce4b990583ab40625b5f283e2169eb36。
// model-mapper 只提取实际使用的 modelRefFromInternal，hydration 提取三条模型读取函数。
// 禁止用新版 Reader 冒充回滚验证；更新 fixture 需明确变更旧基线。
// frozen:apps/zcode-cli/packages/bootstrap/src/tool-call-product-visibility.ts
var EMPTY_TOOL_NAME_PLACEHOLDER = "empty_tool_name";
function shouldHideInvalidToolCallFromProduct(toolName, metadata) {
  if (typeof toolName !== "string") return false;
  if (toolName.trim().length === 0) return true;
  const providerToolName = metadata?.providerToolName;
  return (
    toolName === EMPTY_TOOL_NAME_PLACEHOLDER &&
    providerToolName !== void 0 &&
    typeof providerToolName === "string" &&
    providerToolName.trim().length === 0
  );
}

// frozen:apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-mapper.ts
function modelRefFromInternal(input) {
  return {
    modelId: String(input.modelId ?? input.modelID),
    providerId: String(input.providerId ?? input.providerID),
    variant: input.variant,
  };
}

// apps/zcode-cli/packages/bootstrap/src/zcode-protocol/message-mapper.ts
function mapMessageWithParts(message) {
  return {
    info:
      message.info.role === "user"
        ? {
            agent: message.info.agent,
            messageId: String(message.info.id),
            model: modelRefFromInternal(message.info.model),
            metadata: message.info.metadata,
            role: "user",
            semantics: message.info.semantics,
            sessionId: String(message.info.sessionID),
            source: message.info.source,
            system: message.info.system,
            synthetic: message.info.synthetic,
            time: message.info.time,
            tools: message.info.tools,
            visibility: message.info.visibility,
          }
        : {
            agent: message.info.agent,
            cost: message.info.cost,
            error: message.info.error
              ? { name: message.info.error.name, data: message.info.error.data }
              : void 0,
            finish: message.info.finish,
            messageId: String(message.info.id),
            model: modelRefFromInternal({
              modelID: message.info.modelID,
              providerID: message.info.providerID,
              variant: message.info.variant,
            }),
            parentMessageId: String(message.info.parentID),
            path: message.info.path,
            role: "assistant",
            semantics: message.info.semantics,
            sessionId: String(message.info.sessionID),
            structured: message.info.structured,
            time: message.info.time,
            tokens: message.info.tokens,
          },
    parts: message.parts
      .filter(
        (part) =>
          part.type !== "tool" || !shouldHideInvalidToolCallFromProduct(part.tool, part.metadata),
      )
      .map(mapMessagePart),
  };
}
function mapMessagePart(part) {
  const base = {
    messageId: String(part.messageID),
    partId: String(part.id),
    sessionId: String(part.sessionID),
  };
  switch (part.type) {
    case "text":
      return {
        ...base,
        ignored: part.ignored,
        metadata: part.metadata,
        synthetic: part.synthetic,
        text: part.text,
        type: "text",
      };
    case "reasoning":
      return { ...base, metadata: part.metadata, text: part.text, type: "reasoning" };
    case "file":
      return {
        ...base,
        filename: part.filename,
        metadata: part.metadata,
        mime: part.mime,
        type: "file",
        url: part.url,
      };
    case "tool":
      return {
        ...base,
        callId: part.callID,
        metadata: mapToolPartMetadata(part.metadata),
        state: mapToolState(part.state),
        tool: part.tool,
        type: "tool",
      };
    case "step-start":
      return { ...base, snapshot: part.snapshot, type: "step-start" };
    case "step-finish":
      return {
        ...base,
        cost: part.cost,
        reason: part.reason,
        snapshot: part.snapshot,
        tokens: part.tokens,
        type: "step-finish",
      };
    case "snapshot":
      return { ...base, snapshot: part.snapshot, type: "snapshot" };
    case "patch":
      return { ...base, files: part.files, hash: part.hash, type: "patch" };
    case "compaction":
      return {
        ...base,
        auto: part.auto,
        metadata: {
          attempt: part.attempt,
          boundaryId: part.boundaryId,
          compactReason: part.compactReason,
          endedAt: part.time?.end,
          maxAttempts: part.maxAttempts,
          operationId: part.operationId,
          phase: part.phase,
          postCompactTokenCount: part.postCompactTokenCount,
          preCompactTokenCount: part.preCompactTokenCount,
          reason: part.reason,
          replace: part.replace,
          startedAt: part.time?.start,
          summaryMessageId: part.summaryMessageId,
          timelineStatus: part.timelineStatus,
          truePostCompactTokenCount: part.truePostCompactTokenCount,
          trigger: part.trigger,
        },
        reason: part.reason,
        summaryMessageId: part.summaryMessageId,
        type: "compaction",
      };
    case "timeline":
      return {
        ...base,
        anchorMessageId: part.anchorMessageId ? String(part.anchorMessageId) : void 0,
        anchorTurnId: part.anchorTurnId ? String(part.anchorTurnId) : void 0,
        attempt: part.timelineType === "context_compaction" ? part.attempt : void 0,
        boundaryId: part.timelineType === "context_compaction" ? part.boundaryId : void 0,
        compactReason: part.timelineType === "context_compaction" ? part.compactReason : void 0,
        display: part.display,
        fromModel:
          part.timelineType === "model_change" ? mapTimelineModelRef(part.fromModel) : void 0,
        goalIteration: part.timelineType === "goal_verification" ? part.goalIteration : void 0,
        maxAttempts: part.timelineType === "context_compaction" ? part.maxAttempts : void 0,
        operationId: part.timelineType === "context_compaction" ? part.operationId : void 0,
        parentSessionId:
          part.timelineType === "session_fork" ? String(part.parentSessionId) : void 0,
        phase: part.timelineType === "context_compaction" ? part.phase : void 0,
        postCompactTokenCount:
          part.timelineType === "context_compaction" ? part.postCompactTokenCount : void 0,
        preCompactTokenCount:
          part.timelineType === "context_compaction" ? part.preCompactTokenCount : void 0,
        reason: part.timelineType === "context_compaction" ? part.reason : void 0,
        restoredFileCount: part.timelineType === "session_fork" ? part.restoredFileCount : void 0,
        status: part.status,
        summaryMessageId:
          part.timelineType === "context_compaction" && part.summaryMessageId
            ? String(part.summaryMessageId)
            : void 0,
        targetCheckpointId: part.timelineType === "session_fork" ? part.targetCheckpointId : void 0,
        targetId: part.timelineType === "goal_verification" ? part.targetId : void 0,
        targetMessageId:
          part.timelineType === "session_fork" ? String(part.targetMessageId) : void 0,
        time: part.time,
        timelineType: part.timelineType,
        toModel:
          part.timelineType === "model_change" ? mapRequiredTimelineModelRef(part.toModel) : void 0,
        trigger: part.timelineType === "context_compaction" ? part.trigger : void 0,
        truePostCompactTokenCount:
          part.timelineType === "context_compaction" ? part.truePostCompactTokenCount : void 0,
        type: "timeline",
        verification: part.timelineType === "goal_verification" ? part.verification : void 0,
        verificationId: part.timelineType === "goal_verification" ? part.verificationId : void 0,
      };
    case "subtask":
      return {
        ...base,
        agent: part.agent,
        command: part.command,
        description: part.description,
        model: part.model ? modelRefFromInternal(part.model) : void 0,
        prompt: part.prompt,
        type: "subagent",
      };
    case "agent":
      return { ...base, name: part.name, type: "agent" };
    case "retry":
      return {
        ...base,
        attempt: part.attempt,
        error: { name: part.error.name, data: part.error.data },
        type: "retry",
      };
  }
}
function mapTimelineModelRef(model) {
  if (!model) return void 0;
  return {
    label: model.label,
    modelId: model.modelID,
    providerId: model.providerID,
    variant: model.variant,
  };
}
function mapRequiredTimelineModelRef(model) {
  return {
    label: model.label,
    modelId: model.modelID,
    providerId: model.providerID,
    variant: model.variant,
  };
}
function mapToolPartMetadata(metadata) {
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, "providerToolName")) {
    return metadata;
  }
  const visibleMetadata = { ...metadata };
  delete visibleMetadata.providerToolName;
  return Object.keys(visibleMetadata).length > 0 ? visibleMetadata : void 0;
}
function mapToolState(state) {
  switch (state.status) {
    case "pending":
      return { input: state.input, raw: state.raw, status: "pending" };
    case "running":
      return {
        input: state.input,
        metadata: mapToolStateMetadata(state.metadata),
        startedAt: state.time.start,
        status: "running",
        title: state.title,
      };
    case "completed":
      return {
        completedAt: state.time.end,
        input: state.input,
        metadata: mapCompletedToolStateMetadata(state.metadata),
        output: state.output,
        startedAt: state.time.start,
        status: "completed",
        title: state.title,
      };
    case "error":
      return {
        completedAt: state.time.end,
        error: state.error,
        input: state.input,
        metadata: mapErrorToolStateMetadata(state.metadata),
        startedAt: state.time.start,
        status: "error",
      };
  }
}
function mapToolStateMetadata(metadata) {
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, "readFileState")) {
    return metadata;
  }
  const protocolMetadata = { ...metadata };
  delete protocolMetadata.readFileState;
  return protocolMetadata;
}
function mapErrorToolStateMetadata(metadata) {
  const protocolMetadata = mapToolStateMetadata(metadata);
  if (
    !protocolMetadata ||
    !Object.prototype.hasOwnProperty.call(protocolMetadata, "modelContent")
  ) {
    return protocolMetadata;
  }
  const visibleMetadata = { ...protocolMetadata };
  delete visibleMetadata.modelContent;
  return visibleMetadata;
}
function mapCompletedToolStateMetadata(metadata) {
  const protocolMetadata = mapToolStateMetadata(metadata);
  if (
    !protocolMetadata ||
    !Object.prototype.hasOwnProperty.call(protocolMetadata, "modelContentLayout")
  ) {
    return protocolMetadata ?? {};
  }
  const visibleMetadata = { ...protocolMetadata };
  delete visibleMetadata.modelContentLayout;
  return visibleMetadata;
}
export { mapMessageWithParts };

function turnModelRefOfUserMessage(message) {
  if (message.info.role !== "user") return null;
  const model = message.info.model;
  if (!model?.providerID || !model.modelID) return null;
  return {
    providerId: String(model.providerID),
    modelId: String(model.modelID),
    ...(model.variant ? { variant: model.variant } : {}),
  };
}
function assistantModelRefOf(message) {
  if (message.info.role !== "assistant") return null;
  if (message.info.semantics?.kind === "timeline_event") return null;
  if (!message.info.providerID || !message.info.modelID) return null;
  return {
    providerId: String(message.info.providerID),
    modelId: String(message.info.modelID),
    ...(message.info.variant ? { variant: message.info.variant } : {}),
  };
}
function modelChangeToModelOf(message) {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (part.type !== "timeline" || part.timelineType !== "model_change") continue;
    return {
      modelRef: {
        providerId: String(part.toModel.providerID),
        modelId: String(part.toModel.modelID),
        ...(part.toModel.variant ? { variant: part.toModel.variant } : {}),
      },
      previousModelRef: part.fromModel
        ? {
            providerId: String(part.fromModel.providerID),
            modelId: String(part.fromModel.modelID),
            ...(part.fromModel.variant ? { variant: part.fromModel.variant } : {}),
          }
        : null,
    };
  }
  return null;
}
export { assistantModelRefOf, modelChangeToModelOf, turnModelRefOfUserMessage };
