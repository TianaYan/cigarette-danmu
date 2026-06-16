/* ============================================================
   虚拟烟状态机 (像素风 + 烟雾从燃烧点发射 + 烟灰散落)
   ============================================================ */
(function () {
  const CFG = window.CIGARETTE_CONFIG;

  const els = {};
  let state = 'idle';
  let burnPercent = 0;
  let lastTickTs = 0;
  let rafId = 0;
  let cooldownTimer = 0;

  // 烟灰粒子(烧完后散落)
  const ashParticles = [];
  let ashRafId = 0;

  // 烟雾 canvas
  let smokeCanvas, smokeCtx;
  const smokeParticles = [];
  let smokeLastSpawn = 0;
  let smokeRafId = 0;
  // 当前燃烧点(屏幕坐标), 每帧更新
  let emberScreenX = 0;
  let emberScreenY = 0;

  const PAPER_TOP = 20;
  const PAPER_HEIGHT = 143;
  const FILTER_TOP = 167;
  // 猛吸一口: 燃烧速度临时倍率 + 持续时间
  const PUFF_MULTIPLIER = 7;        // 燃烧速度 ×7
  const PUFF_DURATION_MS = 1000;    // 持续 1 秒
  let puffEndTs = 0;                // 猛吸结束时间戳
  // 火星底部在 SVG 视口里的 y 坐标(贴在燃烧线上)
  function getEmberSvgY() {
    return PAPER_TOP + (burnPercent / 100) * PAPER_HEIGHT;
  }

  function init() {
    els.svg      = document.getElementById('cigSvg');
    els.paper    = document.getElementById('cigPaper');
    els.ash      = document.getElementById('cigAsh');
    els.ember    = document.getElementById('cigEmber');
    els.spark    = document.getElementById('cigSpark');
    els.btn      = document.getElementById('igniteBtn');
    els.btnLabel = document.getElementById('igniteLabel');
    els.extBtn   = document.getElementById('extinguishBtn');
    els.extLabel = document.getElementById('extinguishLabel');
    els.wrap     = document.getElementById('cigWrap');

    // 烟雾 canvas 覆盖整个 cig-wrap
    smokeCanvas = document.getElementById('smokeCanvas');
    smokeCtx = smokeCanvas.getContext('2d');
    resizeSmokeCanvas();
    window.addEventListener('resize', resizeSmokeCanvas);

    // 初始化烟灰组(空,后续 JS 动态填充方块)
    buildAshBlocks(0);

    els.btn.addEventListener('click', ignite);
    els.extBtn.addEventListener('click', extinguish);
  }

  function resizeSmokeCanvas() {
    if (!smokeCanvas || !els.wrap) return;
    const rect = els.wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    smokeCanvas.width = rect.width * dpr;
    smokeCanvas.height = rect.height * dpr;
    smokeCanvas.style.width = rect.width + 'px';
    smokeCanvas.style.height = rect.height + 'px';
    smokeCtx.setTransform(1, 0, 0, 1, 0, 0);
    smokeCtx.scale(dpr, dpr);
  }

  /* 把火星位置(屏幕坐标)同步给 emberScreenX/Y
     关键: 用 SVG 的 getCTM() 把视口坐标(0..200)准确转成屏幕坐标
     之前用 svgRect.height / 200 在 preserveAspectRatio="meet" 下会算错
  */
  function updateEmberScreenPos() {
    if (!els.svg || !els.wrap) return;
    const ctm = els.svg.getScreenCTM();
    if (!ctm) return;
    const emberSvgY = getEmberSvgY();
    // 火星在 SVG 视口里 x=20 (烟中心), y=emberSvgY
    const svgPt = els.svg.createSVGPoint();
    svgPt.x = 20;
    svgPt.y = emberSvgY;
    const screenPt = svgPt.matrixTransform(ctm);
    const wrapRect = els.wrap.getBoundingClientRect();
    emberScreenX = screenPt.x - wrapRect.left;
    emberScreenY = screenPt.y - wrapRect.top;

    // 调试: 第一帧打印一次
    if (!updateEmberScreenPos._logged) {
      updateEmberScreenPos._logged = true;
      console.log('[cig] ember screen pos:', emberScreenX.toFixed(1), emberScreenY.toFixed(1),
                  'wrap:', wrapRect.width.toFixed(0), 'x', wrapRect.height.toFixed(0),
                  'svg y viewbox:', emberSvgY);
    }
  }

  /* 状态机:
     - idle     : 未点燃, 点烟按钮 = "点烟", 熄灭按钮 = 隐藏
     - lighting : 短暂过渡 (200ms), 熄灭按钮 = 隐藏
     - lit      : 燃烧中, 点烟按钮 = "猛吸一口", 熄灭按钮 = "熄灭" (显示)
     - paused   : 手动熄灭后, 点烟按钮 = "点烟", 熄灭按钮 = 隐藏
                  (看着像 idle, 但 burnPercent 保留)
     - dead     : 自然烧到 100%, 烟灰散落, 4s 后重置
  */
  function setState(next) {
    state = next;
    if (next === 'idle') {
      els.btnLabel.textContent = '点烟';
      els.extLabel.textContent = '熄灭';
      els.btn.classList.remove('is-lit', 'is-cooldown', 'is-puff');
      els.svg.classList.remove('is-lit', 'is-puff');
      els.ember.setAttribute('opacity', '0');
      els.spark.setAttribute('opacity', '0');
      els.btn.hidden = false;
      els.extBtn.hidden = true;          // ★ 未点燃: 熄灭按钮隐藏
      stopSmoke();
      clearAsh();
    } else if (next === 'lighting') {
      els.btnLabel.textContent = '点烟中…';
      els.extLabel.textContent = '熄灭';
      els.btn.classList.add('is-lit');
      els.svg.classList.add('is-lit');
      els.spark.setAttribute('opacity', '1');
      els.btn.hidden = false;
      els.extBtn.hidden = true;
      setTimeout(() => els.spark.setAttribute('opacity', '0'), 600);
    } else if (next === 'lit') {
      els.btnLabel.textContent = '猛吸一口';
      els.extLabel.textContent = '熄灭';
      els.btn.classList.add('is-lit');
      els.svg.classList.add('is-lit');
      els.ember.setAttribute('opacity', '1');
      els.btn.hidden = false;
      els.extBtn.hidden = false;         // ★ 燃烧中: 两按钮都显示
      startSmoke();
      lastTickTs = performance.now();
      rafId = requestAnimationFrame(tick);
    } else if (next === 'paused') {
      // ★ 手动熄灭后: UI 回到 idle 状态 (点烟按钮 + 熄灭隐藏), 但 burnPercent 保留
      els.btnLabel.textContent = '点烟';
      els.extLabel.textContent = '熄灭';
      els.btn.classList.remove('is-lit', 'is-puff', 'is-cooldown');
      els.svg.classList.remove('is-lit', 'is-puff');
      els.ember.setAttribute('opacity', '0');
      els.btn.hidden = false;
      els.extBtn.hidden = true;          // ★ 熄灭按钮隐藏
      stopSmoke();
      // 不触发烟灰散落 (没烧完)
      // 烟本体状态保留 (SVG 的 cigPaper/cigAsh 不动)
    } else if (next === 'dead') {
      els.btnLabel.textContent = '已熄灭';
      els.extLabel.textContent = '熄灭';
      els.btn.classList.remove('is-lit', 'is-puff');
      els.btn.classList.add('is-cooldown');
      els.svg.classList.remove('is-lit', 'is-puff');
      els.ember.setAttribute('opacity', '0');
      els.btn.hidden = false;
      els.extBtn.hidden = true;
      stopSmoke();
      spawnAshBurst();
      cooldownTimer = setTimeout(() => {
        burnPercent = 0;
        buildAshBlocks(0);
        setState('idle');
      }, CFG.cooldownMs);
    }
  }

  function ignite() {
    if (state === 'idle') {
      // 全新点燃: burnPercent 留 0
      setState('lighting');
      setTimeout(() => { if (state === 'lighting') setState('lit'); }, 250);
    } else if (state === 'paused') {
      // ★ 暂停后重新点燃: 保留 burnPercent, 从当前进度继续
      // 不重置, 直接进入 lit (从当前 burnPercent 继续烧)
      setState('lit');
    } else if (state === 'lit') {
      // ★ 猛吸一口
      puffEndTs = performance.now() + PUFF_DURATION_MS;
      els.btn.classList.add('is-puff');
      els.svg.classList.add('is-puff');
      smokeLastSpawn = 0;
    }
  }

  function extinguish() {
    if (state === 'lit') {
      // 取消可能的猛吸
      puffEndTs = 0;
      els.btn.classList.remove('is-puff');
      els.svg.classList.remove('is-puff');
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      // ★ 进入 paused: 看着像 idle, 但 burnPercent 保留
      setState('paused');
    }
  }

  function tick(ts) {
    if (state !== 'lit') return;
    const dt = (ts - lastTickTs) / 1000;
    lastTickTs = ts;

    // ★ 猛吸中: 燃烧速度 ×3.5
    const isPuffing = ts < puffEndTs;
    const rate = CFG.burnRatePerSecond * (isPuffing ? PUFF_MULTIPLIER : 1);

    if (!isPuffing && els.btn.classList.contains('is-puff')) {
      // 猛吸结束, 恢复样式
      els.btn.classList.remove('is-puff');
      els.svg.classList.remove('is-puff');
    }

    burnPercent = Math.min(100, burnPercent + rate * dt);
    const emberSvgY = getEmberSvgY();
    // 火星方块组:translate 到对应 y (火星 y=-3..-1 是基线)
    els.ember.setAttribute('transform', `translate(0, ${emberSvgY})`);
    els.spark.setAttribute('transform', `translate(0, ${emberSvgY})`);
    buildAshBlocks(burnPercent);

    if (burnPercent >= 100) { setState('dead'); return; }
    rafId = requestAnimationFrame(tick);
  }

  /* ============================================================
     像素风烟灰: 动态构建 SVG 方块
     ============================================================ */
  function buildAshBlocks(percent) {
    const burnedH = (percent / 100) * PAPER_HEIGHT;
    const inner = els.ash;
    inner.innerHTML = '';  // 清空
    if (burnedH <= 0) return;

    // 烟灰: 12px 宽, 4px 一层, 灰白交替
    const yStart = PAPER_TOP;
    const yEnd = PAPER_TOP + burnedH;
    const colors = ['#4a4a4a', '#6a6a6a', '#5a5a5a', '#7a7a7a'];
    for (let y = yStart; y < yEnd; y += 4) {
      const color = colors[Math.floor((y - yStart) / 4) % colors.length];
      const h = Math.min(4, yEnd - y);
      // 主体
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r.setAttribute('x', 14); r.setAttribute('y', y);
      r.setAttribute('width', 12); r.setAttribute('height', h);
      r.setAttribute('fill', color);
      inner.appendChild(r);
      // 暗边
      const r2 = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r2.setAttribute('x', 13); r2.setAttribute('y', y);
      r2.setAttribute('width', 1); r2.setAttribute('height', h);
      r2.setAttribute('fill', '#2a2a2a');
      inner.appendChild(r2);
      // 高光
      const r3 = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r3.setAttribute('x', 17); r3.setAttribute('y', y);
      r3.setAttribute('width', 1); r3.setAttribute('height', h);
      r3.setAttribute('fill', '#9a9a9a');
      inner.appendChild(r3);
    }
  }

  /* ============================================================
     烟雾 (从燃烧点发射)
     ============================================================ */
  function startSmoke() {
    if (smokeRafId) return;
    smokeLastSpawn = performance.now();
    smokeRafId = requestAnimationFrame(smokeLoop);
  }
  function stopSmoke() {
    if (smokeRafId) { cancelAnimationFrame(smokeRafId); smokeRafId = 0; }
    smokeParticles.length = 0;
    if (smokeCtx) smokeCtx.clearRect(0, 0, smokeCanvas.width, smokeCanvas.height);
  }

  function smokeLoop(ts) {
    updateEmberScreenPos();

    // 猛吸中: 粒子生成间隔减半 (烟雾更浓)
    const isPuffing = ts < puffEndTs;
    const interval = isPuffing ? 22 : 50;
    if (ts - smokeLastSpawn > interval) {
      spawnSmokeParticle(isPuffing);
      smokeLastSpawn = ts;
    }

    smokeCtx.clearRect(0, 0, smokeCanvas.width, smokeCanvas.height);
    const w = smokeCanvas.width / (window.devicePixelRatio || 1);
    const h = smokeCanvas.height / (window.devicePixelRatio || 1);

    for (let i = smokeParticles.length - 1; i >= 0; i--) {
      const p = smokeParticles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy -= 0.02;
      p.vx += (Math.random() - 0.5) * 0.04;
      p.life -= 1;
      p.r += 0.35;
      p.alpha = Math.max(0, p.life / p.maxLife) * 0.55;

      if (p.life <= 0 || p.y < -50 || p.x < -50 || p.x > w + 50) {
        smokeParticles.splice(i, 1);
        continue;
      }

      // 像素风:画方块,不用渐变(也画一层软光做雾感)
      // 先软光晕
      const grad = smokeCtx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
      grad.addColorStop(0, `rgba(210,210,210,${p.alpha})`);
      grad.addColorStop(0.4, `rgba(170,170,170,${p.alpha * 0.5})`);
      grad.addColorStop(1, `rgba(120,120,120,0)`);
      smokeCtx.fillStyle = grad;
      smokeCtx.beginPath();
      smokeCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      smokeCtx.fill();
      // 再叠几个像素方块,做像素感
      smokeCtx.fillStyle = `rgba(220,220,220,${p.alpha * 0.8})`;
      const px = Math.round(p.r / 2);
      for (let k = 0; k < 3; k++) {
        const ox = (Math.random() - 0.5) * p.r * 0.6;
        const oy = (Math.random() - 0.5) * p.r * 0.6;
        smokeCtx.fillRect(Math.round(p.x + ox - px/2), Math.round(p.y + oy - px/2), px, px);
      }
    }
    smokeRafId = requestAnimationFrame(smokeLoop);
  }

  function spawnSmokeParticle(isPuff) {
    if (!smokeCanvas) return;
    // ★ 关键: 从燃烧点 (emberScreenX, emberScreenY) 发射
    // 猛吸时粒子更大、上升更快
    smokeParticles.push({
      x: emberScreenX + (Math.random() - 0.5) * 4,
      y: emberScreenY - 2,
      vx: (Math.random() - 0.5) * (isPuff ? 0.6 : 0.4),
      vy: (isPuff ? -1.6 : -1.0) - Math.random() * 0.7,
      r: (isPuff ? 6 : 4) + Math.random() * 3,
      life: (isPuff ? 100 : 70) + Math.random() * 40,
      maxLife: 140,
      alpha: isPuff ? 0.7 : 0.5,
    });
  }

  /* ============================================================
     烟灰散落
     ============================================================ */
  function clearAsh() {
    ashParticles.length = 0;
  }

  /* 自然散落: 烧完后, 烟灰从烟头位置轻轻飘落
     - 数量少(15 颗)
     - 主要向侧面散, 略向下
     - 短距离(50~80 帧内消失)
     - 没有火花, 没有爆炸, 没有闪烁 */
  function spawnAshBurst() {
    if (!smokeCanvas) return;
    updateEmberScreenPos();
    const cx = emberScreenX;
    const cy = emberScreenY;

    if (ashRafId) cancelAnimationFrame(ashRafId);
    ashRafId = requestAnimationFrame(ashLoop);

    // ★ 强制分配: 8 颗向左, 7 颗向右 (8L+7R 看起来对称, 但不等所以不是镜像)
    for (let i = 0; i < 15; i++) {
      // 头 8 颗向左, 后 7 颗向右
      const side = (i < 8) ? -1 : 1;
      // 角度: 横向为主, 略向下
      const angle = side * (0.35 + Math.random() * 0.4);
      const speed = 0.5 + Math.random() * 0.7;

      ashParticles.push({
        type: 'ash',
        x: cx + (Math.random() - 0.5) * 8,
        y: cy + (Math.random() - 0.5) * 3,
        vx: Math.cos(angle) * speed,
        vy: 0.15 + Math.sin(angle) * 0.2 + Math.random() * 0.15,
        size: 2 + Math.floor(Math.random() * 2),
        life: 30 + Math.random() * 20,
        maxLife: 50,
        color: Math.random() > 0.5 ? '#5a5045' : '#8a7d6e',
      });
    }
  }

  function ashLoop(ts) {
    const w = smokeCanvas.width / (window.devicePixelRatio || 1);
    const h = smokeCanvas.height / (window.devicePixelRatio || 1);

    for (let i = ashParticles.length - 1; i >= 0; i--) {
      const p = ashParticles[i];

      // 物理: 轻重力 + 阻力
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.05;     // ★ 更轻的重力, 不会掉太远
      p.vx *= 0.96;     // 阻力让横向速度衰减
      p.life -= 1;
      p.alpha = Math.max(0, p.life / p.maxLife);

      if (p.life <= 0 || p.y > h + 20 || p.x < -20 || p.x > w + 20) {
        ashParticles.splice(i, 1);
        continue;
      }

      // 像素方块
      smokeCtx.globalAlpha = p.alpha;
      smokeCtx.fillStyle = p.color;
      smokeCtx.fillRect(Math.round(p.x - p.size/2), Math.round(p.y - p.size/2), p.size, p.size);
      // 高光一格
      smokeCtx.fillStyle = '#b8a892';
      smokeCtx.fillRect(Math.round(p.x - p.size/2), Math.round(p.y - p.size/2), p.size, 1);
    }
    smokeCtx.globalAlpha = 1;

    if (ashParticles.length > 0) {
      ashRafId = requestAnimationFrame(ashLoop);
    } else {
      ashRafId = 0;
    }
  }

  function getState() { return { state, burnPercent }; }

  window.Cigarette = { init, ignite, getState };
})();
