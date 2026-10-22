import { expect, it } from "vitest";
import { fixture, port } from "#src/project-storage/test-fixture.js";

it("远端首次迁移按已保存目录及历史任务目录建项目，会话和调度定义归入同目录项目", async () => {
  const { db, add, context } = await fixture(["/repo"]);
  const owner = { ...context, hostId: "remote:server:owner" };
  for (const path of ["/repo", "/history"]) {
    const identity = `remote:ssh:legacy:22:user:${path}`;
    add(path, path, identity);
    db.prepare("INSERT INTO automations VALUES(?,?,?)").run(path, identity, path);
    db.prepare("INSERT INTO off_peak_tasks VALUES(?,?,?)").run(path, identity, path);
  }
  await port.migrate(db, owner);
  const projects = port.repository(db, owner.hostId).readTree().projects;
  const byRoot = new Map(projects.map((project) => [project.roots[0]!.rootPath, project.id]));
  expect([...byRoot.keys()].sort()).toEqual(["/history", "/repo"]);
  for (const table of ["tasks", "automations", "off_peak_tasks"]) {
    expect(
      db
        .prepare(
          `SELECT workspace_key,workspace_path,host_id,project_id FROM ${table} ORDER BY workspace_path`,
        )
        .all(),
    ).toEqual(
      ["/history", "/repo"].map((path) => ({
        workspace_key: `remote:ssh:legacy:22:user:${path}`,
        workspace_path: path,
        host_id: owner.hostId,
        project_id: byRoot.get(path),
      })),
    );
  }
});

it("远端自身没有旧 workspace 清单时，按历史任务目录建项目并跳过系统目录与仅已删除目录", async () => {
  // Bug 回归：桌面控制的旧版远程工作区清单只在控制端 setting.json，远端 settings 为空；
  // 旧逻辑在远端建出 0 个项目，旧会话全部定为未归类而从侧栏消失。
  const { db, add, context } = await fixture();
  const owner = { ...context, hostId: "remote:server:owner" };
  const identity = (path: string) => `remote:ssh:localhost:2222:dev:${path}`;
  add("old-dev", "/home/dev", identity("/home/dev"));
  add("old-a1", "/home/dev/a", identity("/home/dev/a"));
  add("old-a2", "/home/dev/a", identity("/home/dev/a"));
  add("chat", "/home/dev/.zcode/workspace/default", identity("/home/dev/.zcode/workspace/default"));
  add("gone", "/home/dev/gone", identity("/home/dev/gone"));
  db.prepare("UPDATE tasks SET deleted=1 WHERE task_id='gone'").run();
  db.prepare("UPDATE tasks SET updated_at=50 WHERE task_id='old-a2'").run();
  await port.migrate(db, owner);
  const tree = port.repository(db, owner.hostId).readTree({ includeDeleted: true });
  expect(
    tree.projects.map((project) => [project.name, project.roots.map((r) => r.rootPath)]),
  ).toEqual([
    ["a", ["/home/dev/a"]],
    ["dev", ["/home/dev"]],
  ]);
  const projectOf = Object.fromEntries(
    (
      db.prepare("SELECT task_id,project_id FROM tasks").all() as {
        task_id: string;
        project_id: string | null;
      }[]
    ).map((row) => [row.task_id, row.project_id]),
  );
  const byRoot = new Map(tree.projects.map((project) => [project.roots[0]!.rootPath, project.id]));
  expect(projectOf).toEqual({
    "old-dev": byRoot.get("/home/dev"),
    "old-a1": byRoot.get("/home/dev/a"),
    "old-a2": byRoot.get("/home/dev/a"),
    chat: null,
    gone: null,
  });
});

it("本机 owner 仍不从历史任务目录推断项目", async () => {
  const { db, add, context } = await fixture();
  add("old", "/home/dev");
  await port.migrate(db, context);
  expect(port.repository(db).readTree().projects).toEqual([]);
});

it("降级版本新增的定时/闲时定义在再升级时只绑定一次，保留旧版单目录范围", async () => {
  const { db, add, context } = await fixture(["/repo"]);
  add("first", "/repo");
  await port.migrate(db, context);
  const project = String(db.prepare("SELECT project_id FROM projects").get()!.project_id);
  db.exec(`INSERT INTO automations(automation_id,workspace_key,workspace_path) VALUES('legacy','/repo','/repo');
    INSERT INTO off_peak_tasks(off_peak_task_id,workspace_key,workspace_path) VALUES('legacy','/repo','/repo');`);
  await port.migrate(db, context);
  for (const table of ["automations", "off_peak_tasks"]) {
    expect(
      db.prepare(`SELECT host_id,project_id,additional_directories FROM ${table}`).get(),
    ).toEqual({ host_id: "local", project_id: project, additional_directories: "[]" });
  }
  db.prepare("INSERT INTO project_roots VALUES(?,?,?,?)").run(project, "/later", 1, 0);
  db.prepare("UPDATE automations SET additional_directories='[\"/frozen\"]'").run();
  await port.migrate(db, context);
  expect(
    db.prepare("SELECT additional_directories FROM automations").get()!.additional_directories,
  ).toBe('["/frozen"]');
  expect(
    db.prepare("SELECT additional_directories FROM off_peak_tasks").get()!.additional_directories,
  ).toBe("[]");
});

it("再升级的未归类定义保留 NULL，不随之后新增的同目录项目自动归类", async () => {
  const { db, context } = await fixture();
  await port.migrate(db, context);
  db.exec(
    "INSERT INTO automations(automation_id,workspace_key,workspace_path) VALUES('legacy','/repo','/repo')",
  );
  await port.migrate(db, context);
  expect(db.prepare("SELECT host_id,project_id FROM automations").get()).toEqual({
    host_id: "local",
    project_id: null,
  });
  db.exec(
    "INSERT INTO projects(project_id,host_id,name,position,created_at,updated_at) VALUES('later','local','Later',0,1,1); INSERT INTO project_roots VALUES('later','/repo',0,1)",
  );
  await port.migrate(db, context);
  expect(db.prepare("SELECT project_id FROM automations").get()!.project_id).toBeNull();
});

it("Source Server 的降级定义按持库 owner 归属，canonical workspace key 不变", async () => {
  const { db, add, context } = await fixture();
  const identity = "remote:ssh:legacy:22:user:/repo";
  add("first", "/repo", identity);
  const owner = { ...context, hostId: "remote:server:owner" };
  await port.migrate(db, owner);
  db.prepare(
    "INSERT INTO off_peak_tasks(off_peak_task_id,workspace_key,workspace_path) VALUES('legacy',?,'/repo')",
  ).run(identity);
  await port.migrate(db, owner);
  expect(
    db.prepare("SELECT host_id,workspace_key,additional_directories FROM off_peak_tasks").get(),
  ).toEqual({ host_id: owner.hostId, workspace_key: identity, additional_directories: "[]" });
});
