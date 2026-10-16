import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectZCodeSkill, listZCodeSkills } from "../src/skills.js";

describe("inspectZCodeSkill", () => {
  it("loads one discovered skill through the configured skill adapter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-bootstrap-skill-"));
    const skillDir = join(dir, ".zcode", "skills", "demo");

    try {
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: demo",
          "description: Use for demo tasks.",
          "when_to_use: When inspecting skill commands.",
          "---",
          "",
          "# Demo Skill",
          "Follow this workflow.",
        ].join("\n"),
      );

      const inspection = await inspectZCodeSkill({
        env: {},
        name: "demo",
        skipUserConfig: true,
        workingDirectory: dir,
      });

      expect(inspection.diagnostics).toEqual([]);
      expect(inspection.skill.metadata.name).toBe("demo");
      expect(inspection.skill.metadata.whenToUse).toBe("When inspecting skill commands.");
      expect(inspection.skill.content).toContain("# Demo Skill");
      expect(inspection.skill.content).not.toContain("description:");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("returns a stable missing-skill error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-bootstrap-skill-missing-"));

    try {
      await expect(
        inspectZCodeSkill({
          env: {},
          name: "missing",
          skipUserConfig: true,
          workingDirectory: dir,
        }),
      ).rejects.toThrow("Skill not found: missing");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("discovers the built-in dynamic-workflows skill as a bundled system skill, outside any plugin", async () => {
    // 2026-09-19 事故：技能住在可卸载的 zcode-guide 插件里，插件一停用技能就没了。现在它来自
    // packages/bundled-skills（bootstrap/src/app/bundled-skills.ts），与插件启停无关。
    const dir = await mkdtemp(join(tmpdir(), "zcode-bootstrap-bundled-skill-"));

    try {
      const outcome = await listZCodeSkills({
        env: { ZCODE_STORAGE_DIR: join(dir, "storage") },
        skipUserConfig: true,
        workingDirectory: dir,
      });
      const skill = outcome.skills.find((entry) => entry.name === "dynamic-workflows");

      expect(skill).toMatchObject({ scope: "system", source: "bundled" });
      expect(skill?.pluginName).toBeUndefined();
      expect(skill?.qualifiedName).toBeUndefined();
      expect(
        skill?.path.endsWith(join("bundled-skills", "skills", "dynamic-workflows", "SKILL.md")),
      ).toBe(true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("discovers bundled content skills through default-enabled official plugins", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-bootstrap-document-skills-"));

    try {
      const env = { ZCODE_STORAGE_DIR: join(dir, "storage") };
      const outcome = await listZCodeSkills({
        env,
        skipUserConfig: true,
        workingDirectory: dir,
      });
      const bundledSkills = outcome.skills.filter((skill) =>
        ["control-browser", "docx", "pdf", "pptx", "web-gui-tester", "xlsx"].includes(skill.name),
      );

      expect(bundledSkills.map((skill) => skill.name).toSorted()).toEqual([
        "control-browser",
        "docx",
        "pdf",
        "pptx",
        "web-gui-tester",
        "xlsx",
      ]);
      expect(bundledSkills.map((skill) => skill.scope)).toEqual([
        "system",
        "system",
        "system",
        "system",
        "system",
        "system",
      ]);
      expect(bundledSkills.map((skill) => skill.source)).toEqual([
        "plugin",
        "plugin",
        "plugin",
        "plugin",
        "plugin",
        "plugin",
      ]);
      expect(outcome.diagnostics).toEqual([]);

      const pptxInspection = await inspectZCodeSkill({
        env,
        name: "pptx",
        skipUserConfig: true,
        workingDirectory: dir,
      });
      expect(pptxInspection.skill.content).toContain("pptxgenjs");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
