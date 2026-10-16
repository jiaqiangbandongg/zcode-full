import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { outputBinaryName, supportedTargets } from "./sea-targets.mjs";
import { copyReleaseFiles, createConsoleProgressReporter, fileMode } from "./upload-progress.mjs";
import { resolveIntranetMachineHost } from "../../../../../scripts/intranetDefaults.mjs";

export const resolveDefaultSmbUrl = (env = process.env) =>
  `smb://${resolveIntranetMachineHost(env)}/shared`;
export const DEFAULT_SMB_URL = resolveDefaultSmbUrl();
export const DEFAULT_MOUNT_ROOT = "/Volumes/shared";
export const DEFAULT_DESTINATION_ROOT = resolve(DEFAULT_MOUNT_ROOT, "zcode", "deps");
export const RELEASE_DIRECTORY_PREFIX = "zcode-cli-";

const root = resolve(import.meta.dirname, "../../..");
const cliRoot = resolve(import.meta.dirname, "..");
const defaultDist = resolve(cliRoot, "dist");
const usage = `Usage:
  node packages/cli/scripts/upload-sea-smb.mjs
  node packages/cli/scripts/upload-sea-smb.mjs --force
  node packages/cli/scripts/upload-sea-smb.mjs --dest-root /Volumes/shared/zcode/deps
  node packages/cli/scripts/upload-sea-smb.mjs --dist packages/cli/dist
  node packages/cli/scripts/upload-sea-smb.mjs --version 0.12.3

Options:
  --dist <path>       SEA binary dist directory. Defaults to packages/cli/dist.
  --dest-root <path>  Mounted SMB release root. Defaults to /Volumes/shared/zcode/deps.
  --version <text>    Release version. Defaults to the root package.json version.
  --smb-url <url>     SMB label for messages. Defaults to ${DEFAULT_SMB_URL}.
  --force, -f         Replace an existing version directory.
  --help, -h          Show this help.
`;

export const seaUploadBinaryNames = () =>
  supportedTargets.map((target) => outputBinaryName(target));

const resolvePath = (value, cwd) => (isAbsolute(value) ? value : resolve(cwd, value));

const readArgValue = (argv, arg, index) => {
  if (arg.includes("=")) {
    return {
      nextIndex: index,
      value: arg.slice(arg.indexOf("=") + 1),
    };
  }

  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${arg}`);
  }

  return {
    nextIndex: index + 1,
    value,
  };
};

export const parseUploadSeaSmbArgs = (argv, { cwd = process.cwd(), env = process.env } = {}) => {
  const options = {
    destinationRoot: DEFAULT_DESTINATION_ROOT,
    distDir: defaultDist,
    force: false,
    help: false,
    smbUrl: resolveDefaultSmbUrl(env),
    version: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--force" || arg === "-f") {
      options.force = true;
      continue;
    }

    if (arg === "--dist" || arg.startsWith("--dist=")) {
      const { nextIndex, value } = readArgValue(argv, arg, index);
      options.distDir = resolvePath(value, cwd);
      index = nextIndex;
      continue;
    }

    if (arg === "--dest-root" || arg.startsWith("--dest-root=")) {
      const { nextIndex, value } = readArgValue(argv, arg, index);
      options.destinationRoot = resolvePath(value, cwd);
      index = nextIndex;
      continue;
    }

    if (arg === "--version" || arg.startsWith("--version=")) {
      const { nextIndex, value } = readArgValue(argv, arg, index);
      options.version = value;
      index = nextIndex;
      continue;
    }

    if (arg === "--smb-url" || arg.startsWith("--smb-url=")) {
      const { nextIndex, value } = readArgValue(argv, arg, index);
      options.smbUrl = value;
      index = nextIndex;
      continue;
    }

    throw new Error(`Unknown option "${arg}". Run with --help for usage.`);
  }

  return options;
};

const missingFileErrorCode = "ENOENT";

const maybeStat = async (path) => {
  try {
    return await stat(path);
  } catch (error) {
    if (error?.code === missingFileErrorCode) return null;
    throw error;
  }
};

export const readRootPackageVersion = async ({ rootDirectory = root } = {}) => {
  const packagePath = resolve(rootDirectory, "package.json");
  const parsed = JSON.parse(await readFile(packagePath, "utf8"));
  if (typeof parsed.version !== "string" || parsed.version.trim() === "") {
    throw new Error(`Invalid root package version in ${packagePath}`);
  }

  return parsed.version;
};

export const releaseDirectoryName = (version) => {
  const normalized = version.trim();
  if (!normalized || normalized === "." || normalized === ".." || /[\\/]/.test(normalized)) {
    throw new Error(`Invalid release version "${version}"`);
  }

  return `${RELEASE_DIRECTORY_PREFIX}${normalized}`;
};

const assertInsideDirectory = ({ child, parent }) => {
  const childRelativePath = relative(parent, child);
  if (!childRelativePath || childRelativePath.startsWith("..") || isAbsolute(childRelativePath)) {
    throw new Error(`Refusing to write outside destination root: ${child}`);
  }
};

export const collectSeaUploadFiles = async ({ distDir }) => {
  const missing = [];
  const files = [];

  for (const fileName of seaUploadBinaryNames()) {
    const source = resolve(distDir, fileName);
    const fileStat = await maybeStat(source);
    if (!fileStat?.isFile()) {
      missing.push(fileName);
      continue;
    }

    files.push({
      fileName,
      mode: fileMode(fileStat),
      size: fileStat.size,
      source,
    });
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing SEA binaries in ${distDir}: ${missing.join(", ")}. ` +
        "Run `pnpm --filter @zcode/cli build:sea` first.",
    );
  }

  return files;
};

const ensureDirectory = async (path, label) => {
  const pathStat = await maybeStat(path);
  if (!pathStat) {
    throw new Error(`${label} does not exist: ${path}`);
  }

  if (!pathStat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
  }
};

export const ensureDestinationRoot = async ({ destinationRoot, smbUrl }) => {
  if (destinationRoot === DEFAULT_DESTINATION_ROOT) {
    await ensureDirectory(
      DEFAULT_MOUNT_ROOT,
      `Default SMB mount root for ${smbUrl}. Mount ${smbUrl} before uploading`,
    );
  }

  await mkdir(destinationRoot, {
    recursive: true,
  });
  await ensureDirectory(destinationRoot, "Destination root");
};

export const promptExistingVersionAction = async ({
  destination,
  stdin = process.stdin,
  stdout = process.stdout,
} = {}) => {
  if (!stdin.isTTY) {
    throw new Error(
      `Release directory already exists: ${destination}. ` +
        "Re-run with --force to replace it, or remove it manually.",
    );
  }

  const rl = createInterface({
    input: stdin,
    output: stdout,
  });

  try {
    for (;;) {
      const answer = (
        await rl.question(
          `Release directory already exists: ${destination}\nChoose [a]bandon or [f]orce update: `,
        )
      )
        .trim()
        .toLowerCase();

      if (!answer || answer === "a" || answer === "abandon") return "abandon";
      if (answer === "f" || answer === "force") return "force";
      stdout.write("Please enter `a` to abandon or `f` to force update.\n");
    }
  } finally {
    rl.close();
  }
};

export const uploadSeaBinaries = async ({
  confirmExistingVersion = promptExistingVersionAction,
  destinationRoot,
  distDir,
  force,
  onProgress = () => {},
  rootDirectory = root,
  smbUrl,
  version,
}) => {
  const releaseVersion = version ?? (await readRootPackageVersion({ rootDirectory }));
  const releaseName = releaseDirectoryName(releaseVersion);
  const targetDirectory = resolve(destinationRoot, releaseName);
  const stagingDirectory = resolve(
    destinationRoot,
    `.${releaseName}.uploading-${process.pid}-${Date.now()}`,
  );
  assertInsideDirectory({
    child: targetDirectory,
    parent: destinationRoot,
  });
  assertInsideDirectory({
    child: stagingDirectory,
    parent: destinationRoot,
  });

  const files = await collectSeaUploadFiles({
    distDir,
  });
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  await ensureDestinationRoot({
    destinationRoot,
    smbUrl,
  });

  const existing = await maybeStat(targetDirectory);
  if (existing && !existing.isDirectory()) {
    throw new Error(`Release destination exists but is not a directory: ${targetDirectory}`);
  }

  let shouldReplace = force;
  if (existing && !force) {
    const action = await confirmExistingVersion({
      destination: targetDirectory,
    });
    if (action === "abandon") {
      return {
        bytes: totalBytes,
        destination: targetDirectory,
        files,
        status: "abandoned",
        version: releaseVersion,
      };
    }

    shouldReplace = true;
  }

  await rm(stagingDirectory, {
    force: true,
    recursive: true,
  });
  await mkdir(stagingDirectory, {
    recursive: true,
  });

  try {
    await copyReleaseFiles({
      files,
      onProgress,
      stagingDirectory,
    });

    if (shouldReplace) {
      await rm(targetDirectory, {
        force: true,
        recursive: true,
      });
    }

    await rename(stagingDirectory, targetDirectory);
  } catch (error) {
    await rm(stagingDirectory, {
      force: true,
      recursive: true,
    }).catch(() => undefined);
    throw error;
  }

  return {
    bytes: totalBytes,
    destination: targetDirectory,
    files,
    status: "uploaded",
    version: releaseVersion,
  };
};

export const main = async (argv = process.argv.slice(2)) => {
  const options = parseUploadSeaSmbArgs(argv);

  if (options.help) {
    process.stdout.write(usage);
    return;
  }

  const result = await uploadSeaBinaries({
    ...options,
    onProgress: createConsoleProgressReporter(),
  });

  if (result.status === "abandoned") {
    process.stdout.write(`[upload] abandoned existing release ${basename(result.destination)}\n`);
    return;
  }

  process.stdout.write(`[upload] uploaded ${result.files.length} files to ${result.destination}\n`);
};

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
