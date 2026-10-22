import { resolve } from "node:path";
import { expect, it } from "vitest";
import { createDocumentOwner } from "#office/app/documents.ts";
import { createWorkspaceFiles } from "#office/adapters/files.ts";
it("keeps view reports separate and never picks the last writer when ambiguous", async () => {
  const owner = createDocumentOwner({
    files: createWorkspaceFiles(resolve(import.meta.dirname, "../../fixtures")),
    parse: async () => {
      throw new Error("not needed");
    },
  });
  await owner.report({ viewId: "first", path: "paper.pdf", at: "page:1" });
  await owner.report({ viewId: "second", path: "report.docx", at: "p:1" });
  expect(owner.views()).toHaveLength(2);
  expect(owner.view().path).toBeNull();
  expect(owner.view("first").path).toBe("paper.pdf");
  expect(owner.view("second").path).toBe("report.docx");
  owner.releaseView("second");
  expect(owner.view().path).toBe("paper.pdf");
  owner.close();
  expect(owner.views()).toEqual([]);
});

it("a report finishing after release cannot resurrect a closed viewer", async () => {
  const files = createWorkspaceFiles(resolve(import.meta.dirname, "../../fixtures"));
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const owner = createDocumentOwner({
    files: {
      ...files,
      resolve: async (input) => {
        await gate;
        return files.resolve(input);
      },
    },
    parse: async () => {
      throw new Error("not needed");
    },
  });
  const pending = owner.report({ viewId: "closed", path: "paper.pdf" });
  owner.releaseView("closed");
  release();
  await pending;
  expect(owner.views()).toEqual([]);
});
