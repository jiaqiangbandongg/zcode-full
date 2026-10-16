import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";
import {
  loadBuiltinProviderConfig,
  resolveBuiltinProviderBuildEnvironment,
  stageBuiltinProviderConfig,
} from "../builtin-provider-config.mjs";
import { buildCli } from "../../apps/zcode-cli/packages/cli/scripts/build.mjs";
import {
  collectSeaProviderConfigAssets,
  SEA_ZCODE_BUILTIN_PROVIDER_CONFIG_ASSET_KEY,
} from "../../apps/zcode-cli/packages/cli/scripts/sea-provider-config-assets.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const productionFile = "config/provider/zcode-builtin.json";
const testFile = "config/provider/zcode-builtin.test.json";
const baseline = JSON.parse(await readFile(resolve(repositoryRoot, productionFile), "utf8"));

test("both environments load the decoder through a portable file URL", async () => {
  // 在独立进程中检查真实入口传给 tsx 的参数，让非 Windows CI 也能捕获盘符路径回归。
  await promisify(execFile)(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      "--input-type=module",
      "-e",
      `
      import assert from "node:assert/strict";
      import { mock } from "node:test";
      import { tsImport } from "tsx/esm/api";
      let calls = 0;
      mock.module("tsx/esm/api", { namedExports: {
        tsImport: async (specifier, parent) => {
          assert.equal(new URL(specifier).protocol, "file:");
          calls++;
          return tsImport(specifier, parent);
        },
      }});
      const { loadBuiltinProviderConfig } = await import("./scripts/builtin-provider-config.mjs");
      for (const environment of ["production", "test"]) {
        await loadBuiltinProviderConfig({ env: { ZCODE_ENV: environment } });
      }
      assert.equal(calls, 2);
    `,
    ],
    { cwd: repositoryRoot },
  );
});

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), "zcode-builtin-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, "config/provider"), { recursive: true });
  await writeFile(resolve(root, productionFile), JSON.stringify({ ...baseline, revision: 101 }));
  await writeFile(resolve(root, testFile), JSON.stringify({ ...baseline, revision: 202 }));
  return root;
}

for (const [environment, file, revision] of [
  ["test", testFile, 202],
  ["production", productionFile, 101],
]) {
  test(`${environment} selects and stages only its own validated release`, async (t) => {
    const root = await fixture(t);
    const directory = resolve(root, "dist/provider");
    const result = await stageBuiltinProviderConfig({
      root,
      directory,
      env: { ZCODE_ENV: environment, NODE_ENV: "production" },
    });
    assert.equal(result.environment, environment);
    assert.equal(result.sourcePath, resolve(root, file));
    assert.equal(
      JSON.parse(await readFile(resolve(directory, "zcode-builtin.json"), "utf8")).revision,
      revision,
    );
    const assets = await collectSeaProviderConfigAssets({ root, env: { ZCODE_ENV: environment } });
    assert.equal(assets[SEA_ZCODE_BUILTIN_PROVIDER_CONFIG_ASSET_KEY], resolve(root, file));
  });

  test(`${environment} CLI bundle and its adjacent resource agree`, async (t) => {
    const root = await fixture(t);
    const rootDirectory = resolve(root, "apps/zcode-cli");
    const cliDirectory = resolve(rootDirectory, "packages/cli");
    await mkdir(resolve(cliDirectory, "src"), { recursive: true });
    await writeFile(resolve(cliDirectory, "src/main.ts"), "console.log('fixture CLI');");
    // CLI 构建会把仓库根声明作为伴随文件复制到 dist；缺失时构建应失败而不是生成空声明。
    await writeFile(resolve(root, "THIRD-PARTY-NOTICES.md"), "fixture notices\n");
    await buildCli({
      rootDirectory,
      cliDirectory,
      version: "1.0.0",
      sourcemap: false,
      env: { ZCODE_ENV: environment },
    });
    assert.match(await readFile(resolve(cliDirectory, "dist/zcode.cjs"), "utf8"), /fixture CLI/);
    assert.equal(
      await readFile(resolve(cliDirectory, "dist/THIRD-PARTY-NOTICES.md"), "utf8"),
      "fixture notices\n",
    );
    assert.equal(
      JSON.parse(await readFile(resolve(cliDirectory, "dist/provider/zcode-builtin.json"), "utf8"))
        .revision,
      revision,
    );
  });
}

test("environment precedence is explicit env > env files > test; NODE_ENV alone is not production", async (t) => {
  const root = await fixture(t);
  assert.equal(
    await resolveBuiltinProviderBuildEnvironment({ root, env: { NODE_ENV: "production" } }),
    "test",
  );
  await writeFile(resolve(root, ".env"), "ZCODE_ENV=production\n");
  assert.equal(await resolveBuiltinProviderBuildEnvironment({ root, env: {} }), "production");
  await writeFile(resolve(root, ".env.production"), "ZCODE_ENV=test\n");
  assert.equal(
    await resolveBuiltinProviderBuildEnvironment({ root, env: { NODE_ENV: "production" } }),
    "test",
  );
  assert.equal(
    await resolveBuiltinProviderBuildEnvironment({
      root,
      env: { ZCODE_ENV: " production ", NODE_ENV: "production" },
    }),
    "production",
  );
  await assert.rejects(
    loadBuiltinProviderConfig({ root, env: { ZCODE_ENV: "staging" } }),
    /ZCODE_ENV/,
  );
});

test("reused JS still gets fresh config after switching environment or updating the same environment", async (t) => {
  const root = await fixture(t);
  const directory = resolve(root, "dist/provider");
  await mkdir(resolve(root, "dist"));
  const js = resolve(root, "dist/zcode.cjs");
  await writeFile(js, "existing CLI JS");
  for (const [environment, revision] of [
    ["production", 101],
    ["test", 202],
    ["test", 203],
  ]) {
    if (revision === 203)
      await writeFile(resolve(root, testFile), JSON.stringify({ ...baseline, revision }));
    await stageBuiltinProviderConfig({ root, directory, env: { ZCODE_ENV: environment } });
    assert.equal(
      JSON.parse(await readFile(resolve(directory, "zcode-builtin.json"), "utf8")).revision,
      revision,
    );
    assert.equal(await readFile(js, "utf8"), "existing CLI JS");
  }
});

for (const invalid of [null, "{broken", "{}", JSON.stringify({ ...baseline, config: {} })]) {
  test(`invalid selected config fails without falling back (${invalid ?? "missing"})`, async (t) => {
    const root = await fixture(t);
    if (invalid === null) await rm(resolve(root, testFile));
    else await writeFile(resolve(root, testFile), invalid);
    await assert.rejects(
      loadBuiltinProviderConfig({ root, env: { ZCODE_ENV: "test" } }),
      /zcode-builtin.test.json/,
    );
    await assert.rejects(collectSeaProviderConfigAssets({ root, env: { ZCODE_ENV: "test" } }));
    assert.equal(
      JSON.parse(
        (await loadBuiltinProviderConfig({ root, env: { ZCODE_ENV: "production" } })).content,
      ).revision,
      101,
    );
  });
}

test("both repository configurations pass the runtime release decoder", async () => {
  for (const environment of ["test", "production"]) {
    assert.ok(
      (await loadBuiltinProviderConfig({ root: repositoryRoot, env: { ZCODE_ENV: environment } }))
        .content.length > 0,
    );
  }
});

test("Turbo and bootstrap include the out-of-workspace configuration inputs", async () => {
  const turbo = JSON.parse(
    await readFile(resolve(repositoryRoot, "apps/zcode-cli/turbo.json"), "utf8"),
  );
  for (const taskName of ["@zcode/cli#build", "build:desktop-agent"]) {
    const task = turbo.tasks[taskName];
    assert.ok(task.env.includes("ZCODE_ENV"));
    assert.ok(task.env.includes("NODE_ENV"));
    for (const input of [
      productionFile,
      testFile,
      "scripts/builtin-provider-config.mjs",
      "packages/provider/src/**",
      "packages/provider-node/src/zcode-builtin-release.ts",
    ]) {
      assert.ok(task.inputs.includes(`$TURBO_ROOT$/../../${input}`), `${taskName}: ${input}`);
    }
  }
  const bootstrap = await readFile(
    resolve(repositoryRoot, "scripts/build-desktop-agent-cli.mjs"),
    "utf8",
  );
  assert.match(bootstrap, /await stageBuiltinProviderConfig\(/);
});

test("real tsup config bundling retains helper location and embeds selected release", async (t) => {
  const originalEnvironment = process.env.ZCODE_ENV;
  t.after(() => {
    if (originalEnvironment === undefined) delete process.env.ZCODE_ENV;
    else process.env.ZCODE_ENV = originalEnvironment;
  });
  // 使用 tsup 自己依赖的配置加载器，覆盖其先 bundle 配置文件再执行的真实路径。
  const { bundleRequire } = createRequire(import.meta.resolve("tsup"))("bundle-require");
  for (const environment of ["test", "production"]) {
    process.env.ZCODE_ENV = environment;
    const expected = await loadBuiltinProviderConfig();
    for (const packageName of ["server", "zcode-server-cli", "desktop"]) {
      const filepath = resolve(repositoryRoot, "packages", packageName, "tsup.config.ts");
      const { mod } = await bundleRequire({ filepath, cwd: dirname(filepath), format: "esm" });
      if (packageName === "desktop") {
        assert.equal(JSON.parse(mod.default[0].define.__ZCODE_ENV__), environment);
        continue;
      }
      const defines = mod.SERVER_HTTP_DEFINES ?? mod.SERVER_CLI_DEFINES;
      const result = await build({
        stdin: { contents: "export default __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__;" },
        define: defines,
        write: false,
        format: "esm",
      });
      const { default: embedded } = await import(
        `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
      );
      assert.equal(embedded, expected.content);
    }
    const { default: builder } = await import(
      `${pathToFileURL(resolve(repositoryRoot, "packages/desktop/electron-builder.config.js")).href}?env=${environment}`
    );
    const resource = builder.extraResources.find(
      (entry) => entry.to === "config/provider/zcode-builtin.json",
    );
    assert.equal(resource.from, expected.sourcePath);
  }
});
