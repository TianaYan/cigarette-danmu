// Supabase 配置
window.APP_CONFIG = {
  SUPABASE_URL: "https://dyalctkmlhtyspysioyh.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_9Xr0WVHQBsFVJjINsRUvcw_k05yHlh2",

  // 老 Worker 路径 - 不再使用
  WORKER_WS_URL: "",
  WORKER_HTTP_URL: "",
};

// 烟的默认参数 + 弹幕飞行参数
window.CIGARETTE_CONFIG = {
  burnRatePerSecond: 1.2,
  cooldownMs: 4000,
  maxDanmuLength: 40,
  maxHistory: 80,
  flyMinSec: 8,
  flyMaxSec: 14,
};
