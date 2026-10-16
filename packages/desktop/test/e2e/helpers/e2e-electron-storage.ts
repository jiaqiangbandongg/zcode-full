export async function flushElectronStorageData(browser: WebdriverIO.Browser) {
  await browser.electron.execute(async (electron) => {
    const sessions = new Set(
      electron.BrowserWindow.getAllWindows().map((window) => window.webContents.session),
    );
    await Promise.all([...sessions].map((session) => session.flushStorageData()));
  });
}
