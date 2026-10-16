import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { data, inside, rel } from "../lib/path.js"
import { brief, ok, run } from "../lib/run.js"
import { boot } from "./sim.js"

type Shot = {
  udid?: string
  device?: string
  runtime?: string
  path?: string
  openSimulator?: boolean
}

export async function shot(input: Shot = {}) {
  const sim = await boot({
    udid: input.udid,
    name: input.device,
    runtime: input.runtime,
    open: input.openSimulator,
  })
  const file = input.path
    ? inside(process.cwd(), input.path)
    : path.join(await data("screenshots"), `${stamp()}-${sim.udid}.png`)
  await mkdir(path.dirname(file), { recursive: true })

  const out = await run(["xcrun", "simctl", "io", sim.udid, "screenshot", file], { timeout: 30_000 })
  if (!ok(out)) throw new Error(brief(out))
  const bytes = await readFile(file)
  return {
    simulator: sim,
    path: rel(file),
    bytes: bytes.byteLength,
    data: bytes.toString("base64"),
  }
}

function stamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, "-")
}
