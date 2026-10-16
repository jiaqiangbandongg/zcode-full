import { HostResponseTypes, type NetworkCaptureBatch } from "@zcode/shared";
import { createNodeNetworkCapture } from "@zcode/shared/node";
import { localRuntimeNetworkCapture } from "@zcode/services/node";

export function createHostNetworkCapture(
  port: { postMessage(message: unknown): void } | undefined,
) {
  const send = (batch: NetworkCaptureBatch) => {
    try {
      port?.postMessage({ type: HostResponseTypes.NetworkCaptureBatch, batch });
    } catch {
      /* 观测丢弃，不影响 Host 主链路 */
    }
  };
  const nodeCapture = createNodeNetworkCapture("host", send);
  return {
    setCaptureId(captureId: string | null) {
      nodeCapture.setCaptureId(captureId);
      localRuntimeNetworkCapture.setCaptureId(captureId, captureId ? send : undefined);
    },
  };
}
