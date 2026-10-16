import { describe, expect, it, vi } from "vitest";
import {
  SIDEBAR_PURPOSE_SECTION_PREFERENCES_STORAGE_KEY,
  persistSidebarPurposeSectionPreferences,
  readSidebarPurposeSectionPreferences,
  reorderSidebarPurposeSections,
} from "@/lib/sidebarPurposeSectionPreferences.js";

function createStorageMock(initial: Record<string, string> = {}) {
  const storage = new Map(Object.entries(initial));
  return {
    getItem(key: string) {
      return storage.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
    },
  };
}

describe("sidebarPurposeSectionPreferences", () => {
  it("defaults both purpose sections to expanded", () => {
    expect(readSidebarPurposeSectionPreferences(createStorageMock())).toEqual({
      projectsExpanded: true,
      conversationsExpanded: true,
      sectionOrder: ["projects", "conversations"],
    });
  });

  it("persists and restores each purpose section independently", () => {
    const storage = createStorageMock();

    persistSidebarPurposeSectionPreferences(
      {
        projectsExpanded: false,
        conversationsExpanded: true,
        sectionOrder: ["conversations", "projects"],
      },
      storage,
    );

    expect(storage.getItem(SIDEBAR_PURPOSE_SECTION_PREFERENCES_STORAGE_KEY)).toBe(
      JSON.stringify({
        projectsExpanded: false,
        conversationsExpanded: true,
        sectionOrder: ["conversations", "projects"],
      }),
    );
    expect(readSidebarPurposeSectionPreferences(storage)).toEqual({
      projectsExpanded: false,
      conversationsExpanded: true,
      sectionOrder: ["conversations", "projects"],
    });
  });

  it("falls back missing or invalid fields independently", () => {
    const storage = createStorageMock({
      [SIDEBAR_PURPOSE_SECTION_PREFERENCES_STORAGE_KEY]: JSON.stringify({
        projectsExpanded: false,
        conversationsExpanded: "no",
      }),
    });

    expect(readSidebarPurposeSectionPreferences(storage)).toEqual({
      projectsExpanded: false,
      conversationsExpanded: true,
      sectionOrder: ["projects", "conversations"],
    });

    storage.setItem(
      SIDEBAR_PURPOSE_SECTION_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ conversationsExpanded: false }),
    );
    expect(readSidebarPurposeSectionPreferences(storage)).toEqual({
      projectsExpanded: true,
      conversationsExpanded: false,
      sectionOrder: ["projects", "conversations"],
    });
  });

  it("falls back to the default order for duplicate or unknown section ids", () => {
    const storage = createStorageMock({
      [SIDEBAR_PURPOSE_SECTION_PREFERENCES_STORAGE_KEY]: JSON.stringify({
        sectionOrder: ["conversations", "conversations"],
      }),
    });

    expect(readSidebarPurposeSectionPreferences(storage).sectionOrder).toEqual([
      "projects",
      "conversations",
    ]);

    storage.setItem(
      SIDEBAR_PURPOSE_SECTION_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ sectionOrder: ["conversations", "unknown"] }),
    );
    expect(readSidebarPurposeSectionPreferences(storage).sectionOrder).toEqual([
      "projects",
      "conversations",
    ]);
  });

  it("reorders the whole purpose section without changing its identity", () => {
    expect(
      reorderSidebarPurposeSections(["projects", "conversations"], "conversations", "projects"),
    ).toEqual(["conversations", "projects"]);
    expect(
      reorderSidebarPurposeSections(["conversations", "projects"], "projects", "conversations"),
    ).toEqual(["projects", "conversations"]);
  });

  it("falls back to defaults for invalid JSON", () => {
    const storage = createStorageMock({
      [SIDEBAR_PURPOSE_SECTION_PREFERENCES_STORAGE_KEY]: "{",
    });

    expect(readSidebarPurposeSectionPreferences(storage)).toEqual({
      projectsExpanded: true,
      conversationsExpanded: true,
      sectionOrder: ["projects", "conversations"],
    });
  });

  it("falls back safely when storage cannot be read", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error("storage unavailable");
      }),
      setItem: vi.fn(),
    };

    expect(readSidebarPurposeSectionPreferences(storage)).toEqual({
      projectsExpanded: true,
      conversationsExpanded: true,
      sectionOrder: ["projects", "conversations"],
    });
  });

  it("does not throw when storage cannot be written", () => {
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error("storage unavailable");
      }),
    };

    expect(() =>
      persistSidebarPurposeSectionPreferences(
        {
          projectsExpanded: false,
          conversationsExpanded: false,
          sectionOrder: ["conversations", "projects"],
        },
        storage,
      ),
    ).not.toThrow();
  });
});
