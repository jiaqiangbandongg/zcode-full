import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const repositoryRoot = resolve(import.meta.dirname, "..");
export const noticesFileName = "THIRD-PARTY-NOTICES.md";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function readThirdPartyNotices(root = repositoryRoot) {
  // 开发和构建只消费已有声明；输入新鲜度由显式 license 检查负责，避免修改 skill 就阻断构建。
  return readFile(resolve(root, noticesFileName));
}

export async function readVerifiedNotices(root = repositoryRoot, { requireComplete = false } = {}) {
  const manifest = JSON.parse(await readFile(resolve(root, "third-party/inventory.json"), "utf8"));
  if (manifest.schemaVersion !== 1) throw new Error("Unsupported third-party inventory");
  const bytes = await readThirdPartyNotices(root);
  if (hash(bytes) !== manifest.noticesSha256)
    throw new Error("Third-party notices changed; regenerate the inventory");
  for (const [file, expected] of Object.entries(manifest.inputs)) {
    // 工作区文本允许 Windows checkout 的 CRLF；原始许可和发行声明另用字节哈希校验。
    if (hash((await readFile(resolve(root, file), "utf8")).replaceAll("\r\n", "\n")) !== expected) {
      throw new Error(`Third-party input changed: ${file}. Run node scripts/licenses.mjs notices`);
    }
  }
  if (requireComplete && !Array.isArray(manifest.reviewRequired))
    throw new Error("Missing material review inventory; regenerate third-party notices");
  if (requireComplete && manifest.reviewRequired.length) {
    throw new Error(
      `Unresolved third-party material obligations:\n${manifest.reviewRequired.map((item) => `${item.id}: ${item.reason}`).join("\n")}`,
    );
  }
  return bytes;
}

export async function stageThirdPartyNotices(directory, root = repositoryRoot) {
  const bytes = await readThirdPartyNotices(root);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, noticesFileName), bytes);
}

export async function readNodeNotices(version, root = repositoryRoot) {
  const normalized = version.replace(/^v/u, "");
  const sources = JSON.parse(
    await readFile(resolve(root, "third-party/runtime/sources.json"), "utf8"),
  );
  const source = sources.node.find((item) => item.version === normalized);
  if (!source) throw new Error(`Missing Node ${normalized} license provenance`);
  const bytes = await readFile(resolve(root, source.file));
  return { source, bytes };
}

export async function stageNodeNotices(directory, version, root = repositoryRoot) {
  const { source, bytes } = await readNodeNotices(version, root);
  await mkdir(directory, { recursive: true });
  // 修复：复用二进制缓存时也必须刷新声明；只复制 bin/node 会丢掉内嵌库条款。
  await writeFile(resolve(directory, "LICENSE.node.txt"), bytes);
  await writeFile(resolve(directory, "NODE-SOURCES.json"), `${JSON.stringify(source, null, 2)}\n`);
  return resolve(directory, "LICENSE.node.txt");
}

export async function stageElectronNotices(extractedRoot, resources, version) {
  const directory = resolve(resources, "licenses/electron");
  const records = [];
  for (const name of ["LICENSE", "LICENSES.chromium.html"]) {
    let bytes;
    try {
      bytes = await readFile(resolve(extractedRoot, name));
    } catch (error) {
      if (name !== "LICENSE" || error.code !== "ENOENT") throw error;
      bytes = await readFile(resolve(extractedRoot, "LICENSE.electron.txt"));
    }
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, name), bytes);
    records.push({ file: name, sha256: hash(bytes) });
  }
  // 修复：取实际目标平台的解包材料，避免交叉编译误用宿主 Electron 的许可证集合。
  await writeFile(
    resolve(directory, "SOURCES.json"),
    `${JSON.stringify({ version, origin: "electron-builder target distribution", records }, null, 2)}\n`,
  );
}

export async function readNativeSearchNotices(root = repositoryRoot, { verify = false } = {}) {
  const inventoryPath = resolve(root, "third-party/native-search/sources.json");
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  // 原生材料生成时显式核验；准备缓存、构建和打包不把过期登记当作门禁。
  if (verify) {
    for (const [file, expected] of Object.entries(inventory.inputs)) {
      if (hash(await readFile(resolve(root, file))) !== expected)
        throw new Error(`Native license versions changed: ${file}`);
    }
  }
  const records = new Map();
  for (const component of inventory.components) {
    for (const notice of component.notices) {
      const bytes = await readFile(resolve(root, notice.file));
      const sha256 = hash(bytes);
      if (verify && sha256 !== notice.sha256)
        throw new Error(`Changed native notice: ${notice.file}`);
      const record = records.get(sha256) ?? { bytes, components: new Set() };
      record.components.add(`${component.id} ${component.version ?? ""}`.trim());
      records.set(sha256, record);
    }
  }
  const parts = [
    "NATIVE SEARCH THIRD-PARTY NOTICES\n",
    inventory.scope,
    "Ripgrep is available under MIT or Unlicense. Zstd uses its BSD alternative. GCC runtime portions use GPL-3.0 with the GCC Runtime Library Exception 3.1. These component licenses do not relicense the application.",
    "Exact archive checksums, source URLs and notice hashes are recorded in SOURCES.json beside this file.",
  ];
  for (const record of records.values()) {
    parts.push(
      `\n===== ${[...record.components].join("; ")} =====\n`,
      record.bytes.toString("utf8"),
    );
  }
  return { inventory, bytes: Buffer.from(`${parts.join("\n\n")}\n`) };
}

export async function stageNativeSearchNotices(
  plan,
  root = repositoryRoot,
  { builtFromSource = false, origin } = {},
) {
  // 内网镜像与仓库归档是同一 SHA-256 的输入字节，来源标签由调用方如实记录；默认仍为仓库归档。
  const binaryOrigin = origin ?? (builtFromSource ? "source-build" : "repository-archive");
  const { inventory, bytes } = await readNativeSearchNotices(root);
  for (const artifact of plan.artifacts) {
    const directory = dirname(artifact.binaryPath);
    // 缓存命中也重写通知，避免旧二进制缓存继续缺失版权材料。
    await writeFile(resolve(directory, "THIRD-PARTY-NOTICES.txt"), bytes);
    await writeFile(
      resolve(directory, "SOURCES.json"),
      JSON.stringify(
        {
          ...inventory,
          archiveChecksumScope:
            "The archives list records repository binary inputs. Repackaged outputs containing these notices have different archive checksums; the binary below identifies this distribution.",
          binary: {
            toolId: artifact.toolId,
            version: artifact.version,
            sha256: hash(await readFile(artifact.binaryPath)),
            origin: binaryOrigin,
            ...(!builtFromSource ? { sourceArchiveSha256: artifact.archiveSha256 } : {}),
          },
        },
        null,
        2,
      ) + "\n",
    );
  }
}

export function thirdPartyNoticesVitePlugin(root = repositoryRoot) {
  let base = "/";
  return {
    name: "zcode-third-party-notices",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    async generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: noticesFileName,
        source: await readThirdPartyNotices(root),
      });
    },
    transformIndexHtml: {
      order: "post",
      handler: () => [
        {
          tag: "link",
          attrs: {
            rel: "license",
            href: `${base}${noticesFileName}`,
          },
          injectTo: "head",
        },
      ],
    },
  };
}
