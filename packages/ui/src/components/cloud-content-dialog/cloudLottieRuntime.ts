export function validateCloudLottieData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("lottie_data");
  const data = value as Record<string, unknown>;
  for (const dimension of [data.w, data.h])
    if (typeof dimension !== "number" || dimension <= 0 || dimension > 4096)
      throw new Error("lottie_dimensions");
  if (
    typeof data.fr !== "number" ||
    data.fr <= 0 ||
    data.fr > 120 ||
    typeof data.ip !== "number" ||
    typeof data.op !== "number" ||
    !Number.isFinite(data.ip) ||
    !Number.isFinite(data.op) ||
    data.op <= data.ip ||
    data.op - data.ip > data.fr * 600 ||
    !Array.isArray(data.layers)
  )
    throw new Error("lottie_frames");
  let nodes = 0;
  function visit(node: unknown, depth: number) {
    if (++nodes > 50_000 || depth > 40) throw new Error("lottie_complexity");
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      // light 播放器不执行 expressions；同时阻断图片/字体外联，避免绕过资源来源校验。
      if ((["x", "p", "u", "fPath"].includes(key) && typeof child === "string") || key === "fonts")
        throw new Error("lottie_external_or_expression");
      visit(child, depth + 1);
    }
  }
  visit(data, 0);
  return data;
}

export async function loadCloudLottieData(src: string, signal: AbortSignal) {
  const response = await fetch(src, { signal, credentials: "omit", redirect: "error" });
  if (!response.ok || !response.body) throw new Error("lottie_fetch");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error("lottie_size");
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return validateCloudLottieData(JSON.parse(new TextDecoder().decode(bytes)));
}
