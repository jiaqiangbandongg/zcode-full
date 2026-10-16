import { describe, expect, it } from "vitest";
import { z } from "zod";
import { zcodePermissionRequestedEventPayloadSchema } from "../src/zcode-protocol/index.js";
import {
  pendingInteractionSchema,
  permissionRequestPayloadSchema,
} from "../src/zcode-protocol-v4/index.js";

describe("v4 permission payload compatibility", () => {
  const preCapabilityGroupStrictRuleSchema = z
    .object({
      toolName: z.string().min(1),
      ruleContent: z.string().optional(),
    })
    .strict();
  const preCapabilityGroupStrictResponseSchema = z
    .object({
      decision: z.enum(["allow", "deny", "escalate", "modify"]),
      reason: z.string().optional(),
      permissionUpdates: z
        .array(
          z
            .object({
              type: z.literal("addRules"),
              behavior: z.enum(["allow", "deny", "ask"]),
              rules: z.array(preCapabilityGroupStrictRuleSchema).min(1),
            })
            .strict(),
        )
        .optional(),
    })
    .strict();

  it("parses legacy options without an embedded response", () => {
    expect(
      permissionRequestPayloadSchema.parse({
        kind: "permission",
        toolCallId: "tc-legacy",
        toolName: "Bash",
        summary: "Run command",
        detail: { command: "pnpm run lint --fix" },
        options: [
          { optionId: "allowOnce", label: "Allow once", kind: "allowOnce" },
          { optionId: "deny", label: "Deny", kind: "deny" },
        ],
      }).options[0]?.response,
    ).toBeUndefined();
  });

  it("accepts the additive freeText capability in missing, false and true forms", () => {
    const base = {
      kind: "permission" as const,
      toolCallId: "tc-capability",
      toolName: "Bash",
      summary: "Run command",
      detail: { command: "ls" },
      options: [{ optionId: "deny", label: "Deny", kind: "deny" }],
    };

    expect(permissionRequestPayloadSchema.parse(base).freeText).toBeUndefined();
    expect(permissionRequestPayloadSchema.parse({ ...base, freeText: false }).freeText).toBe(false);
    expect(permissionRequestPayloadSchema.parse({ ...base, freeText: true }).freeText).toBe(true);
  });

  it("preserves a project permission response with prefix suggestions", () => {
    const response = {
      decision: "allow" as const,
      permissionUpdates: [
        {
          behavior: "allow" as const,
          rules: [{ ruleContent: "pnpm run lint:*", toolName: "Bash" }],
          type: "addRules" as const,
        },
      ],
    };
    const parsed = permissionRequestPayloadSchema.parse({
      kind: "permission",
      toolCallId: "tc-prefix",
      toolName: "Bash",
      summary: "Run command",
      detail: { command: "pnpm run lint --fix" },
      options: [
        {
          optionId: "allowAlways",
          label: "Always allow",
          kind: "allowAlways",
          response,
        },
      ],
    });

    expect(parsed.options[0]?.response).toEqual(response);
  });

  it("round-trips the trusted official CUA project rule in the legacy wire shape", () => {
    const response = {
      decision: "allow" as const,
      permissionUpdates: [
        {
          behavior: "allow" as const,
          rules: [{ toolName: "zcode:permission-capability:official_cua" }],
          type: "addRules" as const,
        },
      ],
    };

    const parsed = permissionRequestPayloadSchema.parse({
      detail: {},
      kind: "permission",
      options: [
        {
          kind: "allowAlways",
          label: "Always allow Computer Use in this project",
          optionId: "allowAlways",
          response,
        },
      ],
      summary: "Use Computer Use",
      toolCallId: "tc-official-cua",
      toolName: "mcp__computer-use__get_app_state",
    });

    expect(parsed.options[0]?.response).toEqual(response);
    expect(
      preCapabilityGroupStrictResponseSchema.safeParse(parsed.options[0]?.response).success,
    ).toBe(true);
  });

  it("keeps a pending official CUA permission snapshot readable by the pre-MR schema", () => {
    const pending = pendingInteractionSchema.parse({
      interactionId: "permission-official-cua",
      kind: "permission",
      anchorRowId: 7,
      createdAt: 1_785_848_000_000,
      payload: {
        detail: {},
        kind: "permission",
        options: [
          {
            kind: "allowAlways",
            label: "Always allow Computer Use in this project",
            optionId: "allowAlways",
            response: {
              decision: "allow",
              permissionUpdates: [
                {
                  behavior: "allow",
                  rules: [{ toolName: "zcode:permission-capability:official_cua" }],
                  type: "addRules",
                },
              ],
            },
          },
          {
            kind: "deny",
            label: "Deny",
            optionId: "deny",
            response: { decision: "deny" },
          },
        ],
        summary: "Use Computer Use",
        toolCallId: "tc-official-cua",
        toolName: "mcp__computer-use__left_click",
      },
    });

    expect(
      preCapabilityGroupStrictResponseSchema.safeParse(
        pending.payload.kind === "permission" ? pending.payload.options[0]?.response : undefined,
      ).success,
    ).toBe(true);
    expect(
      preCapabilityGroupStrictResponseSchema.safeParse(
        pending.payload.kind === "permission" ? pending.payload.options[1]?.response : undefined,
      ).success,
    ).toBe(true);
  });

  it("keeps the legacy permission.requested event inside the pre-MR strict rule shape", () => {
    const event = zcodePermissionRequestedEventPayloadSchema.parse({
      input: {},
      options: [
        {
          kind: "allow_always",
          name: "Always allow Computer Use in this project",
          optionId: "allow_project",
          response: {
            decision: "allow",
            permissionUpdates: [
              {
                behavior: "allow",
                rules: [{ toolName: "zcode:permission-capability:official_cua" }],
                type: "addRules",
              },
            ],
          },
        },
      ],
      reason: "Use Computer Use",
      riskLevel: "medium",
      suggestedPermissionUpdates: [
        {
          behavior: "allow",
          rules: [{ toolName: "zcode:permission-capability:official_cua" }],
          type: "addRules",
        },
      ],
      toolCallId: "tc-official-cua",
      toolName: "mcp__computer-use__get_app_state",
    });

    expect(
      preCapabilityGroupStrictRuleSchema.safeParse(event.suggestedPermissionUpdates?.[0]?.rules[0])
        .success,
    ).toBe(true);
    expect(
      preCapabilityGroupStrictResponseSchema.safeParse(event.options[0]?.response).success,
    ).toBe(true);
  });

  it("rejects an added capabilityGroup field so wire compatibility cannot regress", () => {
    const parsed = permissionRequestPayloadSchema.safeParse({
      detail: {},
      kind: "permission",
      options: [
        {
          kind: "allowAlways",
          label: "Always allow",
          optionId: "allowAlways",
          response: {
            decision: "allow",
            permissionUpdates: [
              {
                behavior: "allow",
                rules: [
                  {
                    capabilityGroup: "third_party_mcp",
                    toolName: "mcp__fake__left_click",
                  },
                ],
                type: "addRules",
              },
            ],
          },
        },
      ],
      summary: "Use fake tool",
      toolCallId: "tc-fake-group",
      toolName: "mcp__fake__left_click",
    });

    expect(parsed.success).toBe(false);
  });
});
