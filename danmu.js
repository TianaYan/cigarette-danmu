/* ============================================================
   弹幕层 (Supabase Realtime 版)
   - 真实时:对方发消息,这边 < 1s 看到
   - 离线消息也支持:进入页面自动拉最近 100 条
   - 暴露 window.Danmu: init / send / pushIncoming
   ============================================================ */
(function () {
  const CFG = window.CIGARETTE_CONFIG;
  const APP = window.APP_CONFIG;

  const layer = document.getElementById('danmuLayer');

  // 自己发的弹幕单独存,导出按钮用
  const LS_SELF_KEY = 'cig_danmu_self_v1';
  let selfHistory = loadSelf();

  // 已知 id 集合,去重 (Supabase Realtime 可能重复推送,过滤)
  const seen = new Set();

  // 6 条弹幕轨道 (top 百分比), 上下错开, 避免互相重叠
  // 顶部: 0.10 / 0.22 / 0.34
  // 底部: 0.66 / 0.78 / 0.90
  // 留出 0.40-0.60 范围 (烟的中部) 不放弹幕
  const trackRows = [0.10, 0.22, 0.34, 0.66, 0.78, 0.90];
  let lastTrackIdx = -1;

  // Supabase client (通过 CDN 引入,不打包)
  // @supabase/supabase-js@2 全局变量: window.supabase
  const supabase = window.supabase.createClient(APP.SUPABASE_URL, APP.SUPABASE_ANON_KEY);

  function loadSelf() {
    try { return JSON.parse(localStorage.getItem(LS_SELF_KEY) || '[]'); }
    catch { return []; }
  }
  function saveSelf() {
    try { localStorage.setItem(LS_SELF_KEY, JSON.stringify(selfHistory)); } catch {}
  }

  async function init() {
    bindUI();

    // 1. 拉历史
    try {
      const { data, error } = await supabase
        .from('messages')
        .select('id, text, created_at')
        .order('created_at', { ascending: true })
        .limit(CFG.maxHistory);
      if (error) throw error;
      for (const m of (data || [])) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        render({ id: m.id, text: m.text, ts: new Date(m.created_at).getTime() });
      }
    } catch (e) {
      console.warn('history load failed', e);
    }

    // 2. 订阅实时推送
    try {
      const channel = supabase
        .channel('danmu-room')
        .on('postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'messages' },
          (payload) => {
            const m = payload.new;
            if (!m || seen.has(m.id)) return;
            seen.add(m.id);
            render({ id: m.id, text: m.text, ts: new Date(m.created_at).getTime() });
          })
        .subscribe();
      // 留个引用,以后可以 unsubscribe
      window.__danmu_channel = channel;
    } catch (e) {
      console.warn('realtime subscribe failed', e);
    }
  }

  function bindUI() {
    const form = document.getElementById('composer');
    const input = document.getElementById('danmuInput');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      if (text.length > CFG.maxDanmuLength) return;
      input.value = '';
      await send(text);
    });

    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) exportBtn.addEventListener('click', exportSelf);

    const clearBtn = document.getElementById('clearBtn');
    if (clearBtn) clearBtn.addEventListener('click', clearSelf);
  }

  async function send(text) {
    // 简单本地校验(后端 RLS 没开,基本上随便插)
    if (!text) return;

    try {
      const { data, error } = await supabase
        .from('messages')
        .insert({ text })
        .select()
        .single();
      if (error) throw error;
      // 自己的弹幕也存一份,导出用
      if (data) {
        selfHistory.push({
          id: data.id,
          text: data.text,
          ts: new Date(data.created_at).getTime(),
          from: 'self',
        });
        saveSelf();
      }
      // Realtime 会自动把这条消息推回我们和所有订阅者
      // 不需要本地立即渲染(避免重复)
    } catch (e) {
      console.warn('send failed', e);
      alert('发送失败:' + (e.message || e));
    }
  }

  // 颜色调色板
  const PALETTE = ['#ffb27a', '#d49a5e', '#7ec6c0', '#6da8d6', '#d49ab4', '#e8d8b8'];

  function render(m) {
    const el = document.createElement('span');
    el.className = 'danmu';
    const trackIdx = pickTrack();
    el.style.top = (trackRows[trackIdx] * 100) + '%';
    el.textContent = m.text;
    const dur = CFG.flyMinSec + Math.random() * (CFG.flyMaxSec - CFG.flyMinSec);
    el.style.animationDuration = dur + 's';
    const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    el.style.color = color;
    el.style.textShadow = `0 0 6px ${color}33, 0 1px 4px rgba(0,0,0,0.8)`;
    const size = 13 + Math.floor(Math.random() * 4);
    el.style.fontSize = size + 'px';
    layer.appendChild(el);
    setTimeout(() => el.remove(), dur * 1000 + 200);
  }

  function pickTrack() {
    // 优先选空闲轨道: 扫描 layer 看每条轨道当前活跃弹幕数
    const trackCounts = new Array(trackRows.length).fill(0);
    for (const child of layer.children) {
      const tStr = child.style.top;
      if (!tStr || !tStr.endsWith('%')) continue;
      const t = parseFloat(tStr) / 100;
      // 找最接近的轨道
      let minDiff = Infinity, idx = 0;
      for (let i = 0; i < trackRows.length; i++) {
        const d = Math.abs(t - trackRows[i]);
        if (d < minDiff) { minDiff = d; idx = i; }
      }
      trackCounts[idx]++;
    }
    // 找弹幕最少的轨道 (随机一个最少, 避免总是同一条)
    const minCount = Math.min(...trackCounts);
    const candidates = [];
    for (let i = 0; i < trackRows.length; i++) {
      if (trackCounts[i] === minCount) candidates.push(i);
    }
    // 50% 概率选最少轨道, 50% 概率选上次相邻轨道 (避免总是选同一条)
    let chosen;
    if (minCount === 0) {
      // 有空闲轨道: 随机选一个
      chosen = candidates[Math.floor(Math.random() * candidates.length)];
    } else {
      // 都有弹幕: 优先选离上次的远轨道 (让弹幕错开)
      const sorted = candidates.sort((a, b) => {
        const da = Math.abs(a - lastTrackIdx);
        const db = Math.abs(b - lastTrackIdx);
        return db - da;  // 远者优先
      });
      chosen = sorted[0];
    }
    lastTrackIdx = chosen;
    return chosen;
  }

  function exportSelf() {
    if (!selfHistory.length) {
      alert('你还没发过任何弹幕,无法导出。');
      return;
    }
    const lines = [];
    const now = new Date();
    lines.push('# 一根烟 · 匿名弹幕导出');
    lines.push('# 导出时间: ' + formatDate(now));
    lines.push('# 共 ' + selfHistory.length + ' 条');
    lines.push('');
    for (const m of selfHistory) {
      const d = new Date(m.ts);
      lines.push('[' + formatTime(d) + '] ' + m.text);
    }
    const text = lines.join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'danmu-' + ymd(now) + '.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function clearSelf() {
    if (!selfHistory.length && !layer.children.length) return;
    if (!confirm('确定清空"我发过的弹幕"记录和当前屏幕?\n(不会影响云端其他人发的弹幕)')) return;
    selfHistory = [];
    saveSelf();
    layer.innerHTML = '';
    seen.clear();
    // 重新拉一次历史
    init();
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()); }
  function formatTime(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function formatDate(d) { return ymd(d) + ' ' + formatTime(d); }

  function pushIncoming(m) { render(m); }

  window.Danmu = { init, send, pushIncoming, exportSelf, clearSelf };
})();
