import yazl from "yazl";

/** 独立真实 ZIP 用于握手故障，不给产品增加测试专用入口。 */
export async function createMarketingTouchZip(html: Buffer) {
  const archive = new yazl.ZipFile();
  archive.addBuffer(html, "index.html");
  archive.end();
  const chunks: Buffer[] = [];
  for await (const chunk of archive.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function createMarketingTouchFaultBundle() {
  return createMarketingTouchZip(
    Buffer.from(`<!doctype html><script>
    addEventListener('message', ({data}) => {
      if (data?.channel !== 'zcode-cloud-hero-v1' || data.type !== 'init') return;
      if (data.data?.mode === 'wrong-instance') {
        parent.postMessage({channel: data.channel, instanceId: data.instanceId + '-other', type: 'ready'}, '*');
        document.documentElement.dataset.sent = 'wrong-instance';
      }
      if (data.data?.mode === 'error') parent.postMessage({
        channel: data.channel, instanceId: data.instanceId, type: 'error', code: 'e2e_error'
      }, '*');
    });
  </script>`),
  );
}
