/** 页面只需要稳定标识，不能把包含工作区路径与会话身份的内部键直接下发。 */
export async function pluginUiStateKey(surfaceKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(surfaceKey));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
