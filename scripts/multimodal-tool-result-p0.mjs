#!/usr/bin/env node

import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { renderMarkerPng } from "./multimodal-marker-png.mjs";

const MODEL = process.env.ZCODE_MODEL?.trim() || "glm-x-preview-f";
const BASE_URL = (process.env.ZCODE_BASE_URL?.trim() || "https://open.bigmodel.cn/api/anthropic")
  .replace(/\/+$/u, "")
  .replace(/\/v1$/u, "");
const ENDPOINT = `${BASE_URL}/v1/messages`;
const API_KEY = process.env.ANTHROPIC_API_KEY?.trim();
const MAX_TOKENS = parsePositiveInt(process.env.MM_P0_MAX_TOKENS, 256);
const MAX_RETRIES = parseNonNegativeInt(process.env.MM_P0_RETRIES, 2);
const RETRY_DELAY_MS = parseNonNegativeInt(process.env.MM_P0_RETRY_DELAY_MS, 3_000);
const REQUEST_TIMEOUT_MS = parsePositiveInt(process.env.MM_P0_TIMEOUT_MS, 90_000);

export const CASE_NAMES = [
  "text-three-blocks",
  "mcp-text-image-text",
  "android-screenshot-shape",
  "ios-screenshot-shape",
  "browser-multiple-images",
  "cua-observation",
  "multiple-tool-results",
];

const SELECTED_CASES = parseSelectedCases(process.env.MM_P0_CASES);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function main() {
  if (!API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required; it is intentionally not read from a file.");
  }

  const results = [];

  for (const caseName of SELECTED_CASES) {
    const result = await runCase(caseName);
    results.push(result);
    console.log(JSON.stringify(result));
  }

  const failed = results.filter((result) => result.outcome === "FAIL");
  const blocked = results.filter((result) => result.outcome === "BLOCKED");
  console.log(
    JSON.stringify({
      model: MODEL,
      endpoint: ENDPOINT,
      cases: results.length,
      passed: results.filter((result) => result.outcome === "PASS").length,
      failed: failed.length,
      blocked: blocked.length,
    }),
  );

  if (failed.length > 0 || blocked.length === results.length) process.exitCode = 1;
}

async function runCase(caseName) {
  const nonce = crypto.randomBytes(5).toString("hex");
  const probe = await buildCase(caseName, nonce);
  const response = await callModel(probe.messages);

  if (!response.ok) {
    return {
      case: caseName,
      nonce,
      outcome: "BLOCKED",
      http: response.status,
      error: response.error,
    };
  }

  const text = response.text;
  const seen = probe.expected.filter((marker) => text.includes(marker));
  const missing = probe.expected.filter((marker) => !seen.includes(marker));
  const orderOk = hasOrderedMarkers(text, probe.expected);

  return {
    case: caseName,
    nonce,
    outcome: missing.length === 0 && orderOk ? "PASS" : "FAIL",
    http: response.status,
    expected: probe.expected,
    seen,
    missing,
    orderOk,
    response: text.slice(0, 800),
  };
}

export async function buildCase(caseName, nonce) {
  const toolUseId = `toolu_${caseName}`;
  const image = (label) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: label,
    },
  });
  const text = (value) => ({ type: "text", text: value });
  const toolUse = (id, name) => ({ type: "tool_use", id, name, input: {} });
  const instruction = text(
    "Return a JSON array of every marker actually visible in the tool result, including text and text inside images. " +
      "Do not invent markers from this instruction.",
  );

  switch (caseName) {
    case "text-three-blocks": {
      const expected = [`BLOCK0_${nonce}`, `BLOCK1_${nonce}`, `BLOCK2_${nonce}`];
      return {
        expected,
        messages: messagesForOneTool(
          toolUseId,
          "probe",
          [text(expected[0]), text(expected[1]), text(expected[2])],
          instruction,
        ),
      };
    }
    case "mcp-text-image-text": {
      const expected = [`TEXT0_${nonce}`, `P0_VISUAL_${nonce}`, `TEXT2_${nonce}`];
      return {
        expected,
        messages: messagesForOneTool(
          toolUseId,
          "mcp_probe",
          [text(expected[0]), image(await makePng(expected[1])), text(expected[2])],
          instruction,
        ),
      };
    }
    case "android-screenshot-shape":
      return await buildTextImageCase(toolUseId, "android_screenshot", "ANDROID", nonce);
    case "ios-screenshot-shape":
      return await buildTextImageCase(toolUseId, "ios_screenshot", "IOS", nonce);
    case "browser-multiple-images": {
      const expected = [`BROWSER_A_${nonce}`, `BROWSER_B_${nonce}`, `BROWSER_TEXT_${nonce}`];
      return {
        expected,
        messages: messagesForOneTool(
          toolUseId,
          "browser_js",
          [image(await makePng(expected[0])), image(await makePng(expected[1])), text(expected[2])],
          instruction,
        ),
      };
    }
    case "cua-observation": {
      const expected = [
        `CUA_RASTER_${nonce}`,
        `FRAME_REF_${nonce}`,
        `AX_TREE_${nonce}`,
        `ACTION_OUTCOME_${nonce}`,
      ];
      return {
        expected,
        messages: messagesForOneTool(
          toolUseId,
          "get_app_state",
          [
            image(await makePng(expected[0])),
            text(expected[1]),
            text(expected[2]),
            text(expected[3]),
          ],
          instruction,
        ),
      };
    }
    case "multiple-tool-results": {
      const expected = [`A0_${nonce}`, `A1_${nonce}`, `B0_${nonce}`, `B1_${nonce}`];
      return {
        expected,
        messages: [
          {
            role: "assistant",
            content: [toolUse("toolu_a", "probe_a"), toolUse("toolu_b", "probe_b")],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_a",
                content: [text(expected[0]), text(expected[1])],
              },
              {
                type: "tool_result",
                tool_use_id: "toolu_b",
                content: [text(expected[2]), text(expected[3])],
              },
              instruction,
            ],
          },
        ],
      };
    }
    default:
      throw new Error(`Unknown case: ${caseName}`);
  }
}

async function buildTextImageCase(toolUseId, toolName, prefix, nonce) {
  const expected = [`${prefix}_META_${nonce}`, `${prefix}_VISUAL_${nonce}`];
  return {
    expected,
    messages: messagesForOneTool(
      toolUseId,
      toolName,
      [
        { type: "text", text: expected[0] },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: await makePng(expected[1]) },
        },
      ],
      {
        type: "text",
        text: "Return a JSON array of every marker actually visible in the tool result, including text and text inside the image. Do not invent markers from this instruction.",
      },
    ),
  };
}

function messagesForOneTool(toolUseId, toolName, content, instruction) {
  return [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: toolName, input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }, instruction],
    },
  ];
}

async function callModel(messages) {
  const body = JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, messages });
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const raw = await response.text();
      const parsed = parseJson(raw);
      if (response.ok) {
        return {
          ok: true,
          status: response.status,
          text: Array.isArray(parsed?.content)
            ? parsed.content
                .filter((part) => part?.type === "text")
                .map((part) => part.text)
                .join("\n")
            : "",
        };
      }

      lastError = {
        status: response.status,
        error: parsed?.error?.message || `HTTP ${response.status}`,
      };
      if (!isRetryableStatus(response.status) || attempt === MAX_RETRIES) break;
    } catch (error) {
      lastError = {
        status: undefined,
        error: error instanceof Error ? error.message : String(error),
      };
      if (attempt === MAX_RETRIES) break;
    }

    await delay(RETRY_DELAY_MS * (attempt + 1));
  }

  return { ok: false, ...lastError };
}

async function makePng(label) {
  return renderMarkerPng(label).toString("base64");
}

export function parseSelectedCases(value) {
  if (!value?.trim()) return CASE_NAMES;
  const selected = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const unknown = selected.filter((item) => !CASE_NAMES.includes(item));
  if (unknown.length > 0) throw new Error(`Unknown MM_P0_CASES: ${unknown.join(", ")}`);
  return selected;
}

export function hasOrderedMarkers(value, markers) {
  let cursor = -1;
  for (const marker of markers) {
    const index = value.indexOf(marker, cursor + 1);
    if (index < 0) return false;
    cursor = index;
  }
  return true;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRetryableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 529;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
