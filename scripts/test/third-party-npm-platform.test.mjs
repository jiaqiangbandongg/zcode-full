import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createInstallablePackageFilter,
  productionPackages,
  readLockfilePlatformConstraints,
} from "../third-party-npm.mjs";

const LOCKFILE = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      sharp:
        specifier: ^0.34.0
        version: 0.34.5

packages:

  '@emnapi/runtime@1.9.2':
    resolution: {integrity: sha512-a}

  '@img/sharp-linux-s390x@0.34.5':
    resolution: {integrity: sha512-b}
    cpu: [s390x]
    os: [linux]
    libc: [glibc]

  '@img/sharp-linuxmusl-x64@0.34.5':
    resolution: {integrity: sha512-c}
    cpu: [x64]
    os: [linux]
    libc: [musl]

  '@img/sharp-wasm32@0.34.5':
    resolution: {integrity: sha512-d}
    cpu: [wasm32]

  fsevents@2.3.3:
    resolution: {integrity: sha512-e}
    os: [darwin]

  not-windows@1.0.0:
    resolution: {integrity: sha512-f}
    os: ['!win32']

snapshots:

  '@img/sharp-wasm32@0.34.5':
    dependencies:
      '@emnapi/runtime': 1.9.2
    cpu: [arm]
`;

const TARGETS = { os: ["darwin", "linux", "win32"], cpu: ["arm64", "x64"], libc: null };

test("只读取 packages 段的 os/cpu/libc 约束，snapshots 段不参与", () => {
  const constraints = readLockfilePlatformConstraints(LOCKFILE);
  assert.deepEqual(constraints.get("@img/sharp-linux-s390x@0.34.5"), {
    cpu: ["s390x"],
    os: ["linux"],
    libc: ["glibc"],
  });
  assert.deepEqual(constraints.get("@img/sharp-wasm32@0.34.5"), { cpu: ["wasm32"] });
  assert.deepEqual(constraints.get("fsevents@2.3.3"), { os: ["darwin"] });
  assert.deepEqual(constraints.get("not-windows@1.0.0"), { os: ["!win32"] });
  assert.equal(constraints.has("@emnapi/runtime@1.9.2"), false);
});

test("与 pnpm 可安装规则一致：非目标 cpu/os 排除，libc 只在宿主 libc 已知时参与", () => {
  const constraints = readLockfilePlatformConstraints(LOCKFILE);
  const installable = createInstallablePackageFilter(constraints, TARGETS);
  assert.equal(installable("@img/sharp-linux-s390x", "0.34.5"), false);
  assert.equal(installable("@img/sharp-wasm32", "0.34.5"), false);
  assert.equal(installable("fsevents", "2.3.3"), true);
  // pnpm 的否定项语义：目标平台里只要有一个被否定，整个包就不安装。
  assert.equal(installable("not-windows", "1.0.0"), false);
  assert.equal(installable("@img/sharp-linuxmusl-x64", "0.34.5"), true);
  assert.equal(installable("@emnapi/runtime", "1.9.2"), true);

  const glibcHost = createInstallablePackageFilter(constraints, { ...TARGETS, libc: ["glibc"] });
  assert.equal(glibcHost("@img/sharp-linuxmusl-x64", "0.34.5"), false);

  const darwinOnly = createInstallablePackageFilter(constraints, { ...TARGETS, os: ["darwin"] });
  assert.equal(darwinOnly("not-windows", "1.0.0"), true);
  assert.equal(darwinOnly("fsevents", "2.3.3"), true);
  const linuxOnly = createInstallablePackageFilter(constraints, { ...TARGETS, os: ["linux"] });
  assert.equal(linuxOnly("fsevents", "2.3.3"), false);
});

test("不可安装的平台包及只经由它引入的依赖不进生产图", () => {
  const constraints = readLockfilePlatformConstraints(LOCKFILE);
  const installable = createInstallablePackageFilter(constraints, TARGETS);
  const wasm = {
    version: "0.34.5",
    dependencies: { "@emnapi/runtime": { version: "1.9.2" } },
  };
  const onlyViaWasm = [
    {
      name: "app",
      dependencies: {
        sharp: {
          version: "0.34.5",
          optionalDependencies: {
            "@img/sharp-wasm32": wasm,
            "@img/sharp-linux-s390x": { version: "0.34.5" },
          },
        },
      },
    },
  ];
  assert.deepEqual([...productionPackages(onlyViaWasm, installable).keys()], ["sharp@0.34.5"]);

  const alsoDirect = [
    { ...onlyViaWasm[0], optionalDependencies: { "@emnapi/runtime": { version: "1.9.2" } } },
  ];
  assert.deepEqual([...productionPackages(alsoDirect, installable).keys()].sort(), [
    "@emnapi/runtime@1.9.2",
    "sharp@0.34.5",
  ]);
});

test("带 peer 或 patch 后缀的版本按基础版本匹配锁文件约束", () => {
  const constraints = readLockfilePlatformConstraints(LOCKFILE);
  const installable = createInstallablePackageFilter(constraints, TARGETS);
  assert.equal(installable("@img/sharp-wasm32", "0.34.5(patch_hash=abc)"), false);
});
