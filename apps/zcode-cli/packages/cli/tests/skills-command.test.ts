import assert from "node:assert/strict";
import test from "node:test";
import { run } from "../src/run.js";
import type { RunContext } from "@zcode/shared-types";

type CapturedWriteStream = NodeJS.WriteStream & {
  output: () => string;
};

const createWriteStream = (): CapturedWriteStream => {
  let output = "";

  return {
    output: () => output,
    write: (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
      callback?: (err?: Error | null) => void,
    ): boolean => {
      output += typeof chunk === "string" ? chunk : chunk.toString();
      const writeCallback =
        typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      writeCallback?.();
      return true;
    },
  } as CapturedWriteStream;
};

const createContext = (
  argv: string[],
): RunContext & {
  stderr: CapturedWriteStream;
  stdout: CapturedWriteStream;
} => ({
  argv,
  stderr: createWriteStream(),
  stdin: {
    isTTY: false,
  } as NodeJS.ReadStream,
  stdout: createWriteStream(),
});

test("inspects a skill in human format", async () => {
  const ctx = createContext(["skills", "inspect", "demo", "--verbose"]);
  const exitCode = await run(ctx, {
    cwd: () => "/workspace/project",
    inspectSkill: async (options) => {
      assert.equal(options.workingDirectory, "/workspace/project");
      assert.equal(options.name, "demo");
      return createSkillInspection();
    },
  });

  const output = ctx.stdout.output();
  assert.equal(exitCode, 0);
  assert.match(output, /Skill: demo/);
  assert.match(output, /scope\/source: project\/zcode/);
  assert.match(output, /description: Use for demo tasks\./);
  assert.match(output, /safeToAutoLoad: no/);
  assert.match(output, /size: 34\/34 bytes/);
  assert.match(output, /# Demo Skill/);
  assert.match(output, /Diagnostics \(1\)/);
  assert.equal(ctx.stderr.output(), "");
});

test("inspects a skill in JSON format", async () => {
  const ctx = createContext(["skills", "inspect", "demo", "--json"]);
  const exitCode = await run(ctx, {
    cwd: () => "/workspace/project",
    inspectSkill: async () => createSkillInspection(),
  });

  const payload = JSON.parse(ctx.stdout.output()) as {
    cwd: string;
    skill: {
      content: string;
      metadata: { name: string; safeToAutoLoad: boolean };
      truncated: boolean;
    };
  };
  assert.equal(exitCode, 0);
  assert.equal(payload.cwd, "/workspace/project");
  assert.equal(payload.skill.metadata.name, "demo");
  assert.equal(payload.skill.metadata.safeToAutoLoad, false);
  assert.equal(payload.skill.content, "# Demo Skill\nFollow this workflow.");
  assert.equal(payload.skill.truncated, false);
  assert.equal(ctx.stderr.output(), "");
});

test("reports missing skill inspection errors", async () => {
  const ctx = createContext(["skills", "inspect", "missing"]);
  const exitCode = await run(ctx, {
    inspectSkill: async () => {
      throw new Error("Skill not found: missing");
    },
  });

  assert.equal(exitCode, 1);
  assert.match(ctx.stderr.output(), /Error: Skill not found: missing/);
  assert.equal(ctx.stdout.output(), "");
});

test("rejects inspect without a skill name", async () => {
  const ctx = createContext(["skills", "inspect"]);
  const exitCode = await run(ctx, {
    inspectSkill: async () => {
      throw new Error("should not inspect");
    },
  });

  assert.equal(exitCode, 1);
  assert.match(ctx.stderr.output(), /Usage: zcode skills \[list\|inspect <name>\]/);
  assert.equal(ctx.stdout.output(), "");
});

function createSkillInspection() {
  return {
    diagnostics: [
      {
        code: "skill_scan_failed",
        message: "Failed to scan skill directory: demo",
        path: "/workspace/project/.zcode/skills/demo/SKILL.md",
        severity: "warning",
        skillName: "demo",
      },
    ],
    skill: {
      baseDirectory: "/workspace/project/.zcode/skills/demo",
      bytesRead: 34,
      content: "# Demo Skill\nFollow this workflow.",
      metadata: {
        description: "Use for demo tasks.",
        directory: "/workspace/project/.zcode/skills/demo",
        frontmatterKeys: ["name", "description", "version"],
        name: "demo",
        path: "/workspace/project/.zcode/skills/demo/SKILL.md",
        rootPath: "/workspace/project/.zcode/skills",
        safeToAutoLoad: false,
        scope: "project",
        source: "zcode",
      },
      sizeBytes: 34,
      truncated: false,
    },
  } as never;
}
