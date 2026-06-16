/* ============================================================
   入口：初始化所有模块
   ============================================================ */
(function () {
  const APP = window.APP_CONFIG;
  const topHint = document.getElementById('topHint');

  function showHint(text, ttlMs = 2400) {
    if (!topHint) return;
    topHint.textContent = text;
    clearTimeout(showHint._t);
    showHint._t = setTimeout(() => (topHint.textContent = ''), ttlMs);
  }

  function boot() {
    try {
      window.Cigarette.init();
      window.Danmu.init();
    } catch (e) {
      console.error('[app] init failed', e);
    }

    if (APP.SUPABASE_URL) {
      showHint('已连接 Supabase 实时同步', 2400);
    } else if (!APP.WORKER_WS_URL && !APP.WORKER_HTTP_URL) {
      showHint('本地独享模式:消息不会同步给其他人', 4000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
