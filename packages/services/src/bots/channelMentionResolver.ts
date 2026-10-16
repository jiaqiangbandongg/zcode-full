import { createHash } from "node:crypto";
import {
  channelMentionSchema,
  resolveChannelReplyParts,
  type ChannelContentPart,
  type ChannelReplyHostRequest,
  type ChannelReplyResult,
} from "@zcode/shared";

type Mention = Extract<ChannelContentPart, { type: "channelMention" }>;
type Clarification = Extract<ChannelReplyResult, { status: "needs_clarification" }>;
const MAX_CANDIDATES = 10;
const normalizeName = (name: string) => name.normalize("NFKC").trim().toLowerCase();

/** 名字只是查询条件；候选身份只能来自 Provider 目录与已授权原生节点。 */
export function resolveChannelMentionNames(
  parts: ChannelReplyHostRequest["parts"],
  trusted: ChannelContentPart[],
  members: Record<string, string> | undefined,
  scope: string,
  channel: "feishu" | "lark",
  nameCandidates: ChannelContentPart[] = [],
): { parts: ChannelContentPart[] } | Clarification {
  const nodes: Mention[] = [...trusted, ...nameCandidates].filter(
    (part): part is Mention => part.type === "channelMention",
  );
  for (const [targetId, name] of Object.entries(members ?? {})) {
    const node = channelMentionSchema.safeParse({
      type: "channelMention",
      targetId,
      name,
      channel,
      refId: "directory",
      idType: "open_id",
      entityType: "user",
    });
    if (node.success) nodes.push(node.data);
  }
  const resolved: ChannelContentPart[] = [];
  const unresolved: Clarification["unresolved"] = [];
  for (const part of parts) {
    if (part.type !== "mentionName") {
      // 按原语义解析可信 ref，不能把模型提供的名字当成 ref/平台 ID。
      if (part.type === "text") resolved.push(part);
      else resolved.push(...resolveChannelReplyParts([part], trusted));
      continue;
    }
    const byId = new Map<string, Mention>();
    for (const node of nodes) {
      if (
        node.channel === channel &&
        normalizeName(part.name) &&
        normalizeName(node.name).includes(normalizeName(part.name))
      )
        byId.set(node.targetId, node);
    }
    const candidates = [...byId.values()]
      .sort((a, b) => a.targetId.localeCompare(b.targetId))
      .map((node) => ({
        node,
        ref: `name:${createHash("sha256")
          .update(JSON.stringify([scope, node.targetId]))
          .digest("hex")}`,
      }));
    const exact = candidates.filter(
      ({ node }) => normalizeName(node.name) === normalizeName(part.name),
    );
    const automatic =
      exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : undefined;
    const selected = part.candidateRef
      ? candidates.find((candidate) => candidate.ref === part.candidateRef)
      : automatic;
    // 查询失败不能将不完整候选当成唯一匹配，包含可信机器人节点时也一样。
    if (members && selected) {
      resolved.push({ ...selected.node, refId: selected.ref });
      continue;
    }
    // 之前遇到首个失败就返回，后续名字未查却被模型误报为成功；必须收集全部失败项。
    unresolved.push({
      name: part.name,
      reason: !members
        ? "unavailable"
        : part.candidateRef
          ? "selection_expired"
          : candidates.length
            ? "ambiguous"
            : "not_found",
      candidates: members
        ? candidates.slice(0, MAX_CANDIDATES).map(({ node, ref }) => ({
            ref,
            name: node.name,
            kind: node.entityType,
            label: `${node.name} (${node.entityType}, …${node.targetId.slice(-6)})`,
          }))
        : [],
      truncated: candidates.length > MAX_CANDIDATES,
    });
  }
  return unresolved.length ? { status: "needs_clarification", unresolved } : { parts: resolved };
}
