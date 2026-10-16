// 通过已有 Electron 的 MediaRecorder 生成原创小型 WebM fixture，stdout 输出 base64。
const { app, BrowserWindow } = require("electron");
app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      show: false,
      webPreferences: { backgroundThrottling: false },
    });
    try {
      await window.loadURL("data:text/html,<html><body></body></html>");
      const bytes = await window.webContents.executeJavaScript(`(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
      document.body.appendChild(canvas);
      const context = canvas.getContext('2d');
      const stream = canvas.captureStream(10);
      const recorder = new MediaRecorder(stream, {mimeType:'video/webm;codecs=vp8'});
      const parts = [];
      const done = new Promise(resolve => { recorder.ondataavailable = e => parts.push(e.data); recorder.onstop = resolve; });
      recorder.start();
      for (let frame = 0; frame < 12; frame++) {
        context.fillStyle = '#14243c'; context.fillRect(0,0,320,240);
        context.fillStyle = '#78b9ff'; context.fillRect(30 + frame * 15,70,50,50);
        context.fillStyle = '#ffffff'; context.font = '20px sans-serif'; context.fillText('Cloud content video',55,180);
        await new Promise(resolve => setTimeout(resolve,100));
      }
      recorder.stop(); await done; stream.getTracks().forEach(track => track.stop());
      return Array.from(new Uint8Array(await new Blob(parts,{type:'video/webm'}).arrayBuffer()));
    })()`);
      console.log("VIDEO_BASE64=" + Buffer.from(bytes).toString("base64"));
    } finally {
      window.destroy();
      app.quit();
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
