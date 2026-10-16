import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { OFFICIAL_GLM_SELECTION_MIGRATION_SQL } from "../src/storage/session-store/migrations/0021-official-glm-selection.js";

it("只规范化当前官方选择，旧字段、未知/自定义身份、坏 JSON 均不动，重复执行幂等", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE session_entry(id TEXT, type TEXT, data TEXT)");
    const insert = db.prepare("INSERT INTO session_entry VALUES(?,?,?)");
    for (const [id, providerId, modelId] of [
      ["official", "account:zai-start-plan", "glm-5.3-flash"],
      ["custom", "my-provider", "glm-5.3-flash"],
      ["unknown", "account:zai-start-plan", "glm-future"],
      ["ticket", "account:zai-off-peak", "glm-5.3-flash"],
    ])
      insert.run(
        id,
        "runtime/model_selection",
        JSON.stringify({ modelId, modelSelection: { providerId, modelId } }),
      );
    insert.run("bad", "runtime/model_selection", "{");
    insert.run(
      "other",
      "other",
      JSON.stringify({
        modelSelection: { providerId: "account:zai-start-plan", modelId: "glm-5.3-flash" },
      }),
    );
    const before = db.prepare("SELECT * FROM session_entry").all();
    db.exec(OFFICIAL_GLM_SELECTION_MIGRATION_SQL);
    const after = db.prepare("SELECT * FROM session_entry").all();
    expect(JSON.parse(String(after[0]!.data))).toEqual({
      modelId: "glm-5.3-flash",
      modelSelection: { providerId: "account:zai-start-plan", modelId: "GLM-5.3-Flash" },
    });
    expect(after.slice(1)).toEqual(before.slice(1));
    db.exec(OFFICIAL_GLM_SELECTION_MIGRATION_SQL);
    expect(db.prepare("SELECT * FROM session_entry").all()).toEqual(after);
  } finally {
    db.close();
  }
});
