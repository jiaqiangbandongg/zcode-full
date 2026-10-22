import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Collect licences from the modules that actually end up in the bundles, including transitive
 * dependencies. A package without a licence file falls back to its declared SPDX licence and
 * repository so the notice still names it; packages without either fail the build.
 */
export async function writeNotices(metafiles, destination) {
  const packages = new Map();
  for (const input of metafiles.flatMap((meta) => Object.keys(meta.inputs))) {
    if (!input.includes("node_modules/")) continue;
    let directory = dirname(resolve(input));
    while (directory.includes("node_modules")) {
      try {
        const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
        if (pkg.name) {
          packages.set(directory, pkg);
          break;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      directory = dirname(directory);
    }
  }
  const notices = [];
  const seen = new Set();
  for (const [directory, pkg] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const files = (await readdir(directory)).filter((name) =>
      /^(license|licence|copying|notice)([.-]|$)/i.test(name),
    );
    const texts = await Promise.all(files.map((file) => readFile(join(directory, file), "utf8")));
    const license =
      typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license ?? null);
    if (!texts.length) {
      if (!pkg.license) throw new Error(`Missing license for bundled dependency ${key}`);
      const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
      texts.push(`Licensed under ${license}.${repository ? ` Source: ${repository}` : ""}`);
    }
    notices.push(`${key} — ${license}\n${texts.join("\n\n")}`);
  }
  await writeFile(destination, notices.join("\n\n----------------------------------------\n\n"));
}
