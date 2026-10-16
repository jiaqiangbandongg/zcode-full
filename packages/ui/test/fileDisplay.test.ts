import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileDisplayInline,
  buildMaterialFileIconSrc,
  resolveFileDisplayDescriptor,
  setDefaultFileDisplayBasePath,
} from "../src/lib/fileDisplay.js";

afterEach(() => {
  setDefaultFileDisplayBasePath(null);
});

describe("resolveFileDisplayDescriptor", () => {
  it.each([
    { extension: "doc", iconName: "word" },
    { extension: "docx", iconName: "word" },
    { extension: "xlsx", iconName: "table" },
    { extension: "pptx", iconName: "powerpoint" },
    { extension: "mp4", iconName: "video" },
    { extension: "mov", iconName: "video" },
    { extension: "webm", iconName: "video" },
    { extension: "m4v", iconName: "video" },
    { extension: "mp3", iconName: "audio" },
    { extension: "wav", iconName: "audio" },
    { extension: "m4a", iconName: "audio" },
    { extension: "ogg", iconName: "audio" },
    { extension: "opus", iconName: "audio" },
    { extension: "flac", iconName: "audio" },
    { extension: "weba", iconName: "audio" },
  ])(
    "maps .$extension to the $iconName icon for desktop and web",
    async ({ extension, iconName }) => {
      const repoRoot = new URL("../../..", import.meta.url);
      const desktopIcon = await readFile(
        new URL(`packages/desktop/src/renderer/public/material-icons/${iconName}.svg`, repoRoot),
        "utf8",
      );
      const webIcon = await readFile(
        new URL(`packages/web/public/material-icons/${iconName}.svg`, repoRoot),
        "utf8",
      );

      expect(resolveFileDisplayDescriptor(`/workspace/report.${extension}`)).toMatchObject({
        fileIcon: iconName,
        fileIconSrc: buildMaterialFileIconSrc(iconName),
      });
      expect(desktopIcon).toMatch(/^<svg\b/);
      expect(webIcon).toBe(desktopIcon);
    },
  );

  it("infers icon, file name, and parent path from an absolute file path", () => {
    expect(
      resolveFileDisplayDescriptor("/Users/dev/Projects/element-web/apps/web/src/Avatar.ts"),
    ).toMatchObject({
      fileIcon: "typescript",
      fileName: "Avatar.ts",
      filePath: "/Users/dev/Projects/element-web/apps/web/src/",
    });
  });

  it("renders paths relative to the provided basePath", () => {
    expect(
      resolveFileDisplayDescriptor("/Users/dev/Projects/element-web/apps/web/src/Avatar.ts", {
        basePath: "/Users/dev/Projects/element-web",
      }),
    ).toMatchObject({
      fileIcon: "typescript",
      fileName: "Avatar.ts",
      filePath: "apps/web/src/",
    });
  });

  it("falls back to the default workspace basePath when no basePath is provided", () => {
    setDefaultFileDisplayBasePath("/Users/dev/Projects/element-web");

    expect(
      resolveFileDisplayDescriptor("/Users/dev/Projects/element-web/apps/web/src/Avatar.ts"),
    ).toMatchObject({
      fileIcon: "typescript",
      fileName: "Avatar.ts",
      filePath: "apps/web/src/",
    });
  });

  it("keeps dotfiles and known config file icons resolved correctly", () => {
    expect(
      resolveFileDisplayDescriptor("/Users/dev/Projects/element-web/.gitignore"),
    ).toMatchObject({
      fileIcon: "git",
      fileName: ".gitignore",
      filePath: "/Users/dev/Projects/element-web/",
    });

    expect(
      resolveFileDisplayDescriptor("/Users/dev/Projects/element-web/vitest.config.ts"),
    ).toMatchObject({
      fileIcon: "vitest",
      fileName: "vitest.config.ts",
      filePath: "/Users/dev/Projects/element-web/",
    });

    expect(
      resolveFileDisplayDescriptor("/Users/dev/Projects/element-web/tsconfig.base.json"),
    ).toMatchObject({
      fileIcon: "tsconfig",
      fileName: "tsconfig.base.json",
      filePath: "/Users/dev/Projects/element-web/",
    });

    expect(
      resolveFileDisplayDescriptor("/Users/dev/Projects/element-web/.env.local"),
    ).toMatchObject({
      fileIcon: "settings",
      fileName: ".env.local",
      filePath: "/Users/dev/Projects/element-web/",
    });
  });

  it("uses the folder icon when the path kind is directory", () => {
    expect(
      resolveFileDisplayDescriptor("/Users/dev/Projects/element-web/apps/web/src", {
        kind: "directory",
      }),
    ).toMatchObject({
      fileIcon: "folder",
      fileName: "src",
      filePath: "/Users/dev/Projects/element-web/apps/web/",
    });
  });
});

describe("FileDisplayInline", () => {
  it("renders the icon, file name, and relative parent path when requested", () => {
    const html = renderToStaticMarkup(
      createElement(FileDisplayInline, {
        path: "/Users/dev/Projects/element-web/apps/web/src/Avatar.ts",
        options: {
          basePath: "/Users/dev/Projects/element-web",
          showFilePath: true,
        },
      }),
    );

    expect(html).toContain(buildMaterialFileIconSrc("typescript"));
    expect(html).toContain("Avatar.ts");
    expect(html).toContain("apps/web/src/");
  });

  it("hides the parent path when showFilePath is not enabled", () => {
    const html = renderToStaticMarkup(
      createElement(FileDisplayInline, {
        path: "/Users/dev/Projects/element-web/apps/web/src/Avatar.ts",
      }),
    );

    expect(html).toContain(buildMaterialFileIconSrc("typescript"));
    expect(html).toContain("Avatar.ts");
    expect(html).not.toContain("apps/web/src/");
  });
});
