import { ASSET_PREFIX, FILE_PREFIX, type FileHandle } from "#office/contract.ts";
import { getHost } from "#ui/host.ts";

async function read(uri: string) {
  const host = getHost();
  await host.ready();
  const result = await host.app.readServerResource({ uri });
  const item = result.contents[0];
  if (!item) throw new Error(`Empty resource ${uri}`);
  return item as { text?: string; blob?: string };
}

export async function readText(name: string): Promise<string> {
  const item = await read(ASSET_PREFIX + name);
  if (typeof item.text !== "string") throw new Error(`Asset ${name} is not text`);
  return item.text;
}

function decode(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const binaryCache = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

/** Binary asset (wasm, pdf.js cMaps and fonts); cached for the life of the page. */
export function readBinary(name: string): Promise<Uint8Array<ArrayBuffer>> {
  let cached = binaryCache.get(name);
  if (!cached) {
    cached = read(ASSET_PREFIX + name).then((item) => {
      if (typeof item.blob !== "string") throw new Error(`Asset ${name} is not binary`);
      return decode(item.blob);
    });
    cached.catch(() => binaryCache.delete(name));
    binaryCache.set(name, cached);
  }
  return cached;
}

/** Read a loaded document's bytes chunk by chunk. */
export async function readFileBytes(
  handle: FileHandle,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const out = new Uint8Array(handle.bytes);
  let offset = 0;
  for (let index = 0; index < handle.chunks; index++) {
    signal?.throwIfAborted();
    const item = await read(`${FILE_PREFIX}${handle.token}/${index}`);
    if (typeof item.blob !== "string") throw new Error("File chunk is not binary");
    const chunk = decode(item.blob);
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== handle.bytes) throw new Error("The file changed while it was loading; reload it.");
  return out.buffer;
}
