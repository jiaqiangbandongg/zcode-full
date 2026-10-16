// 仅模拟网页对公开 bridge 的消费；不创建 bridge、不伪造 App 鉴权状态。
export const rewardsWebsiteFixture = `<!doctype html>
<html><head><meta charset="utf-8"><title>Rewards bridge fixture</title>
<style>body{margin:0;font-family:sans-serif}main{min-height:2400px;padding:24px;box-sizing:border-box}html[data-theme="dark"]{background:#151515;color:white}</style>
</head><body><main data-embedded="app" data-app-auth="pending"><h1>Rewards bridge fixture</h1><p>Isolated protocol consumer, not production rewards data.</p></main>
<script>
function sync() {
  const bridge = window.zcodeBridge;
  if (!bridge) return;
  const root = document.querySelector('main');
  const theme = bridge.getTheme() === 'zai-dark' ? 'dark' : 'light';
  root.dataset.theme = theme;
  document.documentElement.dataset.theme = theme;
  root.dataset.appAuth = bridge.getAuthState()?.status || 'pending';
  const lang = bridge.getLang();
  if (lang) {
    const url = new URL(location.href);
    url.pathname = '/' + (lang === 'zh-CN' ? 'cn' : 'en') + '/rewards';
    history.replaceState(null, '', url);
  }
}
window.addEventListener('zcode-rewards-context', sync);
sync();
</script></body></html>`;
