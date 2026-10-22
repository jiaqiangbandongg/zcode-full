import { expect, it } from "vitest";
import { readWindowState, writeWindowState } from "#ui/windowStorage.ts";
it("isolates windows and bounds retained state", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
  writeWindowState(storage, "first", { path: "a.pdf", recent: [{ path: "a.pdf", kind: "pdf" }] });
  expect(readWindowState(storage, "second")).toEqual({});
  expect(readWindowState(storage, "first").recent?.[0]?.path).toBe("a.pdf");
  for (let i = 0; i < 129; i++) writeWindowState(storage, `window-${i}`, { path: `${i}.pdf` });
  expect(readWindowState(storage, "first")).toEqual({});
  expect(readWindowState(storage, "window-128").path).toBe("128.pdf");
  expect(Object.keys(JSON.parse([...data.values()][0]))).toHaveLength(128);
});
