import { expect, it } from "vitest";
import { fixture, port } from "#src/project-storage/test-fixture.js";

// 同一台机器上本机桌面与 Source Server 共用 tasks-index；0005 只由首个打开者执行。
const server = "remote:server:shared-mac";

async function sharedFixture() {
  const state = await fixture(["/a"]);
  // 公共 fixture 未开外键；生产连接开启，需在此复现 projects.host_id 外键约束。
  state.db.exec("PRAGMA foreign_keys = ON");
  state.add("local-old", "/a");
  state.add("ssh-old", "/a", "remote:ssh:shared-mac:22:user:/a");
  return state;
}

const owners = (db: Awaited<ReturnType<typeof sharedFixture>>["db"]) =>
  db.prepare("SELECT task_id,host_id,project_id FROM tasks ORDER BY task_id").all();

it("本机桌面先迁移，Source Server 后打开同一库仍可新建项目，且不改旧任务归属", async () => {
  const { db, context } = await sharedFixture();
  await port.migrate(db, context);
  const before = owners(db);
  await port.migrate(db, { ...context, hostId: server });
  expect(port.repository(db, server).saveProject({ roots: ["/a"] })).toMatchObject({
    hostId: server,
    roots: [{ rootPath: "/a", isPrimary: true }],
  });
  expect(owners(db)).toEqual(before);
});

it("Source Server 先迁移，本机桌面后打开同一库仍可新建项目，且不改旧任务归属", async () => {
  const { db, context } = await sharedFixture();
  await port.migrate(db, { ...context, hostId: server });
  const before = owners(db);
  await port.migrate(db, context);
  expect(port.repository(db, undefined).saveProject({ roots: ["/b"] })).toMatchObject({
    hostId: "local",
    roots: [{ rootPath: "/b", isPrimary: true }],
  });
  expect(owners(db)).toEqual(before);
});
