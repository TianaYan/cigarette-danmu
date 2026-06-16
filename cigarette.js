/* ============================================================
   虚拟烟状态机
   状态: idle (未点燃) | lighting (点烟中) | lit (燃烧中) | dying (即将熄灭) | dead (熄灭冷却)
   暴露给 window.Cigarette: init / ignite / getState
   ============================================================ */
(function () {
  const CFG = window.CIGARETTE_CONFIG;

  const els = {};
  let state = 'idle';
  let burnPercent = 0;          // 0..100, 100 = 烧完
  let lastTickTs = 0;
  let rafId = 0;
  let cooldownTimer = 0;
  let smokeTimer = 0;
  let ashRect = null;           // {y, h} 当前灰的位置
  let paperRect = null;         // 纸：y=20, h=143
  const PAPER_TOP = 20;
  const PAPER_HEIGHT = 143;
  const FILTER_TOP = 165;

  function init() {
    els.svg       = document.getElementById('cigSvg');
    els.paper     = document.getElementById('cigPaper');
    els.ash       = document.getElementById('cigAsh');
    els.ember     = document.getElementById('cigEmber');
    els.spark     = document.getElementById('cigSpark');
    els.smoke     = document.getElementById('smoke');
    els.btn       = document.getElementById('igniteBtn');
    els.btnLabel  = document.getElementById('igniteLabel');

    paperRect = { y: PAPER_TOP, h: PAPER_HEIGHT };
    ashRect   = { y: PAPER_TOP, h: 0 };
    renderAsh();

    els.btn.addEventListener('click', ignite);
    // 自适应竖屏：当 viewport 高度变化时，CSS 高度自动重算
  }

  function setState(next) {
    state = next;
    if (next === 'idle') {
      els.btnLabel.textContent = '点烟';
      els.btn.classList.remove('is-lit', 'is-cooldown');
      els.svg.classList.remove('is-lit');
      els.ember.setAttribute('opacity', '0');
      els.spark.setAttribute('opacity', '0');
      stopSmoke();
    } else if (next === 'lighting') {
      els.btnLabel.textContent = '点烟中…';
      els.btn.classList.add('is-lit');
      els.svg.classList.add('is-lit');
      // 点烟火花
      els.spark.setAttribute('opacity', '1');
      setTimeout(() => els.spark.setAttribute('opacity', '0'), 600);
    } else if (next === 'lit') {
      els.btnLabel.textContent = '燃烧中';
      els.btn.classList.add('is-lit');
      els.svg.classList.add('is-lit');
      els.ember.setAttribute('opacity', '1');
      startSmoke();
      lastTickTs = performance.now();
      rafId = requestAnimationFrame(tick);
    } else if (next === 'dead') {
      els.btnLabel.textContent = '已熄灭';
      els.btn.classList.remove('is-lit');
      els.btn.classList.add('is-cooldown');
      els.svg.classList.remove('is-lit');
      els.ember.setAttribute('opacity', '0');
      stopSmoke();
      cooldownTimer = setTimeout(() => {
        // 重置：完全清空
        burnPercent = 0;
        ashRect = { y: PAPER_TOP, h: 0 };
        renderAsh();
        setState('idle');
      }, CFG.cooldownMs);
    }
  }

  function ignite() {
    if (state !== 'idle') return;
    setState('lighting');
    // 200ms 假装“点烟动作”，再进入燃烧
    setTimeout(() => {
      if (state === 'lighting') setState('lit');
    }, 250);
  }

  function tick(ts) {
    if (state !== 'lit') return;
    const dt = (ts - lastTickTs) / 1000;
    lastTickTs = ts;
    burnPercent = Math.min(100, burnPercent + CFG.burnRatePerSecond * dt);
    // 烟灰 = 烧掉的部分，灰的顶端是燃烧线
    const burnedH = (burnPercent / 100) * PAPER_HEIGHT;
    ashRect = {
      y: PAPER_TOP,
      h: burnedH
    };
    // 火星中心贴在灰的底端（即燃烧线），y 坐标 = PAPER_TOP + burnedH
    const emberY = PAPER_TOP + burnedH;
    els.ember.setAttribute('cy', String(emberY));
    // 灰的底端与火星位置一致（视觉上火星在灰中）
    renderAsh();

    if (burnPercent >= 100) {
      setState('dead');
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function renderAsh() {
    // 灰的 y = PAPER_TOP, height = ashRect.h —— 但 SVG 坐标系下，
    // 我们希望“灰是烧剩下的部分”。这里采用：纸变短、灰贴在纸顶端
    // 把 paper 的 y 设为 PAPER_TOP + ashRect.h，h 减为 PAPER_HEIGHT - ashRect.h
    const burnedH = ashRect.h;
    els.paper.setAttribute('y', String(PAPER_TOP + burnedH));
    els.paper.setAttribute('height', String(Math.max(0, PAPER_HEIGHT - burnedH)));
    els.ash.setAttribute('y', String(PAPER_TOP));
    els.ash.setAttribute('height', String(burnedH));
  }

  /* ------------ 烟雾粒子 ------------ */
  function startSmoke() {
    if (smokeTimer) return;
    // 用火星位置作为发射点；这里给一个固定值 40% 高（实际是 svg 视口坐标）
    smokeTimer = setInterval(spawnPuff, 220);
  }
  function stopSmoke() {
    if (smokeTimer) { clearInterval(smokeTimer); smokeTimer = 0; }
    els.smoke.classList.remove('is-active');
    // 清理残留
    Array.from(els.smoke.children).forEach(c => c.remove());
  }
  function spawnPuff() {
    if (!els.smoke.classList.contains('is-active')) els.smoke.classList.add('is-active');
    const puff = document.createElement('div');
    puff.className = 'smoke__puff';
    // 随机水平偏移 / 大小抖动
    const jitterX = (Math.random() - 0.5) * 30;
    puff.style.left = `calc(50% + ${jitterX}px)`;
    const scale = 0.7 + Math.random() * 0.8;
    puff.style.setProperty('--scale', scale);
    puff.style.animationDuration = (3.6 + Math.random() * 1.4) + 's';
    els.smoke.appendChild(puff);
    setTimeout(() => puff.remove(), 5200);
  }

  function getState() { return { state, burnPercent }; }

  window.Cigarette = { init, ignite, getState };
})();
