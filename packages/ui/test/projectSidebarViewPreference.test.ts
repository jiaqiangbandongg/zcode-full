import { expect, it } from "vitest";
import { readProjectSidebarView } from "@/project-sidebar/view-preference.js";
const storage = (current: unknown, legacy: unknown) => ({
  getItem: (key: string) =>
    JSON.stringify(key === "zcode-project-sidebar-preferences" ? current : legacy),
});
it("migrates the previous group selection and keeps a subsequent explicit choice", () => {
  expect(readProjectSidebarView(storage(null, { organizeBy: "grouped" }))).toBe("grouped");
  expect(readProjectSidebarView(storage({ order: [] }, { organizeBy: "grouped" }))).toBe("grouped");
  expect(readProjectSidebarView(storage({ view: "timeline" }, { organizeBy: "grouped" }))).toBe(
    "timeline",
  );
  expect(readProjectSidebarView(storage({ view: "projects" }, { organizeBy: "grouped" }))).toBe(
    "projects",
  );
});
it("maps the old project and timeline values, and tolerates invalid or blocked storage", () => {
  expect(readProjectSidebarView(storage(null, { organizeBy: "chronological" }))).toBe("timeline");
  expect(readProjectSidebarView(storage(null, { organizeBy: "project" }))).toBe("projects");
  expect(readProjectSidebarView(storage(null, { organizeBy: "bad" }))).toBe("projects");
  expect(
    readProjectSidebarView({
      getItem: () => {
        throw new Error("blocked");
      },
    }),
  ).toBe("projects");
});
