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

  // 烟圈 (吐烟圈) 粒子
  const ringParticles = [];
  let ringRafId = 0;

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
  const PUFF_JUMP_PERCENT = 5;      // 猛吸瞬时先咔嚓变短 5%
  const PUFF_DURATION_MS = 1000;    // 持续 1 秒
  let puffEndTs = 0;                // 猛吸结束时间戳
  // 火星底部在 SVG 视口里的 y 坐标(贴在燃烧线上)
  function getEmberSvgY() {
    return PAPER_TOP + (burnPercent / 100) * PAPER_HEIGHT;
  }

  function init() {
    els.svg       = document.getElementById('cigSvg');
    els.paper     = document.getElementById('cigPaper');
    els.ash       = document.getElementById('cigAsh');
    els.filter    = document.getElementById('cigFilter');
    els.ember     = document.getElementById('cigEmber');
    els.spark     = document.getElementById('cigSpark');
    els.btn       = document.getElementById('igniteBtn');
    els.btnLabel  = document.getElementById('igniteLabel');
    els.extBtn    = document.getElementById('extinguishBtn');
    els.extLabel  = document.getElementById('extinguishLabel');
    els.ringBtn   = document.getElementById('ringBtn');
    els.ringLabel = document.getElementById('ringLabel');
    els.wrap      = document.getElementById('cigWrap');
    els.lighter   = document.getElementById('lighter');
    els.flame     = document.getElementById('lighterFlame');

    smokeCanvas = document.getElementById('smokeCanvas');
    smokeCtx = smokeCanvas.getContext('2d');
    resizeSmokeCanvas();
    window.addEventListener('resize', resizeSmokeCanvas);

    // 初始化烟灰组(空,后续 JS 动态填充方块)
    buildAshBlocks(0);

    // ★ 初始手部位置: 全 hidden
    applyLighterPosition(LIGHTER_POS.hidden);

    els.btn.addEventListener('click', ignite);
    els.extBtn.addEventListener('click', extinguish);
    els.ringBtn.addEventListener('click', blowRing);
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

  /* ============================================================
     打火机位置系统 (基于 cig-wrap 100% 定位)
     - hidden    : 打火机和火苗 opacity 0
     - lighting  : 打火机移到火星位置 + 火苗显示
     - 其他状态 : 打火机和火苗都隐藏
     ============================================================ */
  const LIGHTER_POS = {
    hidden:    { lighter: { x: 50, y: 110, opacity: 0 }, flame: { x: 50, y: 110, opacity: 0, lit: false } },
    // 点烟: 打火机贴在烟未燃烧的头上 (火星顶 SVG y=20 = wrap 10%, 火苗在上方)
    lighting:  { lighter: { x: 50, y: 14, opacity: 1 }, flame: { x: 50, y: 8, opacity: 1, lit: true } },
    relighting:{ lighter: { x: 50, y: 14, opacity: 1 }, flame: { x: 50, y: 8, opacity: 1, lit: true } },
    lit:       { lighter: { x: 50, y: 110, opacity: 0 }, flame: { x: 50, y: 110, opacity: 0, lit: false } },
    extinguishing: { lighter: { x: 50, y: 110, opacity: 0 }, flame: { x: 50, y: 110, opacity: 0, lit: false } },
    paused:    { lighter: { x: 50, y: 110, opacity: 0 }, flame: { x: 50, y: 110, opacity: 0, lit: false } },
    dead:      { lighter: { x: 50, y: 110, opacity: 0 }, flame: { x: 50, y: 110, opacity: 0, lit: false } },
  };

  function applyLighterPosition(pos) {
    // 打火机
    if (els.lighter) {
      els.lighter.style.left = pos.lighter.x + '%';
      els.lighter.style.top  = pos.lighter.y + '%';
      els.lighter.style.opacity = pos.lighter.opacity;
      if (pos.lighter.opacity > 0.5) els.lighter.classList.add('is-visible');
      else els.lighter.classList.remove('is-visible');
    }
    // 火苗
    if (els.flame) {
      els.flame.style.left = pos.flame.x + '%';
      els.flame.style.top  = pos.flame.y + '%';
      els.flame.style.opacity = pos.flame.opacity;
      if (pos.flame.lit) els.flame.classList.add('is-lit');
      else els.flame.classList.remove('is-lit');
    }
  }

  // ★ 根据当前 burnPercent 计算打火机位置
  // 起始位置: 离 wrap 底部 40% (即 y=60 从顶算), 跟着燃烧慢慢下移
  // 0% -> y=60, 100% -> y=90 (限制最大 90%)
  function getLighterPosForBurn() {
    const baseY = 60;
    const yOffset = burnPercent * 0.3;
    const yLighter = Math.min(90, baseY + yOffset);
    return {
      lighter: { x: 50, y: yLighter, opacity: 1 },
      flame:   { x: 50, y: yLighter - 7, opacity: 1, lit: true },
    };
  }

  function setState(next) {
    state = next;
    if (next === 'idle') {
      els.btnLabel.textContent = '点烟';
      els.extLabel.textContent = '熄灭';
      els.ringLabel.textContent = '吐个烟圈';
      els.btn.classList.remove('is-lit', 'is-cooldown', 'is-puff');
      els.svg.classList.remove('is-lit', 'is-puff');
      els.ember.setAttribute('opacity', '0');
      els.spark.setAttribute('opacity', '0');
      els.btn.hidden = false;
      els.extBtn.hidden = true;          // 未点燃, 熄灭隐藏
      els.ringBtn.hidden = true;         // ★ 未点燃, 吐烟圈隐藏
      stopSmoke();
      clearAsh();
      applyLighterPosition(LIGHTER_POS.hidden);  // ★ 双手消失
    } else if (next === 'lighting') {
      els.btnLabel.textContent = '点烟中…';
      els.extLabel.textContent = '熄灭';
      els.ringLabel.textContent = '吐个烟圈';
      els.btn.classList.add('is-lit');
      els.svg.classList.add('is-lit');
      els.spark.setAttribute('opacity', '1');
      els.btn.hidden = false;
      els.extBtn.hidden = true;
      els.ringBtn.hidden = true;
      // ★ 打火机瞄准白烟纸 (火星顶位置), 跟着 burnPercent 动态变化
      applyLighterPosition(getLighterPosForBurn());
      setTimeout(() => els.spark.setAttribute('opacity', '0'), 600);
    } else if (next === 'lit') {
      els.btnLabel.textContent = '猛吸一口';
      els.extLabel.textContent = '熄灭';
      els.ringLabel.textContent = '吐个烟圈';
      els.btn.classList.add('is-lit');
      els.svg.classList.add('is-lit');
      els.ember.setAttribute('opacity', '1');
      els.btn.hidden = false;
      els.extBtn.hidden = false;
      els.ringBtn.hidden = false;        // ★ 燃烧中: 三个按钮都显示
      applyLighterPosition(LIGHTER_POS.lit);  // ★ 双手消失
      startSmoke();
      lastTickTs = performance.now();
      rafId = requestAnimationFrame(tick);
    } else if (next === 'relighting') {
      // ★ 重新点燃: 打火机出现在当前火星位置 (跟着 burnPercent 走)
      els.btnLabel.textContent = '点燃中…';
      els.btn.classList.add('is-lit');
      els.svg.classList.add('is-lit');
      els.ember.setAttribute('opacity', '1');
      els.spark.setAttribute('opacity', '1');
      els.btn.hidden = false;
      els.extBtn.hidden = true;
      els.ringBtn.hidden = true;
      applyLighterPosition(getLighterPosForBurn());
      setTimeout(() => els.spark.setAttribute('opacity', '0'), 600);
    } else if (next === 'extinguishing') {
      // ★ 熄灭动画: 右手按住烟到烟灰缸
      els.btnLabel.textContent = '熄灭中…';
      els.btn.classList.remove('is-lit', 'is-puff');
      els.svg.classList.remove('is-lit', 'is-puff');
      els.ember.setAttribute('opacity', '0');
      els.btn.hidden = false;
      els.extBtn.hidden = true;
      els.ringBtn.hidden = true;
      stopSmoke();
      applyLighterPosition(LIGHTER_POS.extinguishing);
    } else if (next === 'paused') {
      els.btnLabel.textContent = '点烟';
      els.extLabel.textContent = '熄灭';
      els.ringLabel.textContent = '吐个烟圈';
      els.btn.classList.remove('is-lit', 'is-puff', 'is-cooldown');
      els.svg.classList.remove('is-lit', 'is-puff');
      els.ember.setAttribute('opacity', '0');
      els.btn.hidden = false;
      els.extBtn.hidden = true;          // 熄灭隐藏
      els.ringBtn.hidden = true;         // ★ 吐烟圈隐藏
      stopSmoke();
      applyLighterPosition(LIGHTER_POS.hidden);  // ★ 双手消失
    } else if (next === 'dead') {
      els.btnLabel.textContent = '已熄灭';
      els.extLabel.textContent = '熄灭';
      els.ringLabel.textContent = '吐个烟圈';
      els.btn.classList.remove('is-lit', 'is-puff');
      els.btn.classList.add('is-cooldown');
      els.svg.classList.remove('is-lit', 'is-puff');
      els.ember.setAttribute('opacity', '0');
      els.btn.hidden = false;
      els.extBtn.hidden = true;
      els.ringBtn.hidden = true;         // ★ 死状态也隐藏
      stopSmoke();
      spawnAshBurst();
      applyLighterPosition(LIGHTER_POS.hidden);  // ★ 双手消失
      cooldownTimer = setTimeout(() => {
        burnPercent = 0;
        buildAshBlocks(0);
        setState('idle');
      }, CFG.cooldownMs);
    }
  }

  function ignite() {
    if (state === 'idle') {
      // ★ 全新点燃: 进入 lighting 动画 (双手伸入 + 打火机 + 点燃)
      // 1.2s 后切到 lit (手消失, 烟稳在中央)
      setState('lighting');
      setTimeout(() => { if (state === 'lighting') setState('lit'); }, 1200);
    } else if (state === 'paused') {
      // ★ 暂停后重新点燃: 双手再伸入 (relighting), 1.2s 后切到 lit
      setState('relighting');
      setTimeout(() => { if (state === 'relighting') setState('lit'); }, 1200);
    } else if (state === 'lit') {
      // ★ 猛吸一口: 先瞬时变短一截 (咔嚓), 再 1 秒内慢烧补足
      burnPercent = Math.min(100, burnPercent + PUFF_JUMP_PERCENT);
      const emberSvgY = getEmberSvgY();
      els.ember.setAttribute('transform', `translate(0, ${emberSvgY})`);
      els.spark.setAttribute('transform', `translate(0, ${emberSvgY})`);
      buildAshBlocks(burnPercent);
      if (burnPercent >= 100) { setState('dead'); return; }

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
      // ★ 进入 extinguishing 动画 (右手按到烟灰缸)
      // 0.8s 后切到 paused (手消失)
      setState('extinguishing');
      setTimeout(() => { if (state === 'extinguishing') setState('paused'); }, 800);
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
     像素风烟纸 + 烟灰: 动态构建 SVG 方块
     滤嘴: 永久固定在 SVG 底部 32px (不跟着 yEnd 走, 不变色)
     金边: 贴在 yEnd (燃烧线) 顶部
     烟纸: 从 yEnd 画到 FILTER_TOP (163), 让出滤嘴位置
     烟灰: 只画火星下方 6px 一小撮
     ============================================================ */
  const PAPER_BOTTOM = PAPER_TOP + PAPER_HEIGHT;  // 163
  const FILTER_HEIGHT = 32;                       // 滤嘴 32px 固定
  const FILTER_TOP_Y = 200 - FILTER_HEIGHT;       // 168 (滤嘴顶部 y)
  const GOLD_HEIGHT = 3;                          // 金边 3px
  const PAPER_DRAW_BOTTOM = FILTER_TOP_Y;         // 烟纸画到 168 (不覆盖滤嘴)
  function buildAshBlocks(percent) {
    const burnedH = (percent / 100) * PAPER_HEIGHT;
    const inner = els.ash;
    const filterEl = els.filter;
    const paperEl = els.paper;
    inner.innerHTML = '';
    if (filterEl) filterEl.innerHTML = '';
    if (paperEl) paperEl.innerHTML = '';

    const yEnd = PAPER_TOP + burnedH;  // 燃烧线位置

    // 1. 滤嘴: 永久固定 (从 FILTER_TOP_Y=168 到 200, 32px 棕色)
    //    不跟着 yEnd 走, 不变色
    if (filterEl) {
      const filterColors = ['#5a3a18', '#8a5a28', '#5a3a18', '#8a5a28', '#5a3a18', '#8a5a28', '#5a3a18', '#3a2410'];
      let fy = FILTER_TOP_Y;
      let colorIdx = 0;
      while (fy < 200) {
        const h = Math.min(4, 200 - fy);
        if (h <= 0) break;
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', '14'); rect.setAttribute('y', String(fy));
        rect.setAttribute('width', '12'); rect.setAttribute('height', String(h));
        rect.setAttribute('fill', filterColors[colorIdx % filterColors.length]);
        filterEl.appendChild(rect);
        // 暗边
        const rect2 = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect2.setAttribute('x', '13'); rect2.setAttribute('y', String(fy));
        rect2.setAttribute('width', '1'); rect2.setAttribute('height', String(h));
        rect2.setAttribute('fill', '#2a1808');
        filterEl.appendChild(rect2);
        fy += h;
        colorIdx++;
      }
    }

    // 2. 金边: 贴在 yEnd 顶部 (跟着燃烧线走)
    if (filterEl) {
      const goldY = yEnd;
      // 金边只画到 FILTER_TOP_Y - 1 (不覆盖滤嘴)
      if (goldY < FILTER_TOP_Y - 1) {
        const gold = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        gold.setAttribute('x', '14'); gold.setAttribute('y', String(goldY));
        gold.setAttribute('width', '12'); gold.setAttribute('height', String(GOLD_HEIGHT));
        gold.setAttribute('fill', '#c79a4a');
        filterEl.appendChild(gold);
        const goldShadow = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        goldShadow.setAttribute('x', '14'); goldShadow.setAttribute('y', String(goldY + GOLD_HEIGHT));
        goldShadow.setAttribute('width', '12'); goldShadow.setAttribute('height', '1');
        goldShadow.setAttribute('fill', '#8a6a2a');
        filterEl.appendChild(goldShadow);
      }
    }

    // 3. 烟纸: 画 yEnd ~ PAPER_DRAW_BOTTOM (168, 不覆盖滤嘴)
    if (paperEl && burnedH < PAPER_HEIGHT) {
      const paperStart = yEnd;
      const paperEnd = PAPER_DRAW_BOTTOM;  // 168
      const paperH = paperEnd - paperStart;
      if (paperH > 0) {
        // 白底
        const main = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        main.setAttribute('x', '14'); main.setAttribute('y', String(paperStart));
        main.setAttribute('width', '12'); main.setAttribute('height', String(paperH));
        main.setAttribute('fill', '#e8e6e0');
        paperEl.appendChild(main);
        // 左暗边
        const darkL = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        darkL.setAttribute('x', '13'); darkL.setAttribute('y', String(paperStart));
        darkL.setAttribute('width', '1'); darkL.setAttribute('height', String(paperH));
        darkL.setAttribute('fill', '#8a8a85');
        paperEl.appendChild(darkL);
        // 右暗边
        const darkR = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        darkR.setAttribute('x', '26'); darkR.setAttribute('y', String(paperStart));
        darkR.setAttribute('width', '1'); darkR.setAttribute('height', String(paperH));
        darkR.setAttribute('fill', '#8a8a85');
        paperEl.appendChild(darkR);
        // 中线高光 (每 8px 一段)
        for (let yy = paperStart; yy < paperEnd; yy += 8) {
          const h = Math.min(1, paperEnd - yy);
          const hl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          hl.setAttribute('x', '18'); hl.setAttribute('y', String(yy));
          hl.setAttribute('width', '1'); hl.setAttribute('height', String(h));
          hl.setAttribute('fill', '#ffffff');
          hl.setAttribute('opacity', '0.6');
          paperEl.appendChild(hl);
        }
      }
    }

    if (burnedH <= 0) return;

    // 4. 烟灰: 只画火星下方 6px 一小撮
    const ashH = Math.min(burnedH, 6);
    if (ashH > 0) {
      const yStart = yEnd - ashH;
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

    // 更新 + 画烟雾粒子
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

      const grad = smokeCtx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
      grad.addColorStop(0, `rgba(210,210,210,${p.alpha})`);
      grad.addColorStop(0.4, `rgba(170,170,170,${p.alpha * 0.5})`);
      grad.addColorStop(1, `rgba(120,120,120,0)`);
      smokeCtx.fillStyle = grad;
      smokeCtx.beginPath();
      smokeCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      smokeCtx.fill();
      smokeCtx.fillStyle = `rgba(220,220,220,${p.alpha * 0.8})`;
      const px = Math.round(p.r / 2);
      for (let k = 0; k < 3; k++) {
        const ox = (Math.random() - 0.5) * p.r * 0.6;
        const oy = (Math.random() - 0.5) * p.r * 0.6;
        smokeCtx.fillRect(Math.round(p.x + ox - px/2), Math.round(p.y + oy - px/2), px, px);
      }
    }

    // ★ 更新 + 画烟圈 (和烟雾共用一个 RAF, 不会被 clearRect 干掉)
    updateAndDrawRings();

    smokeRafId = requestAnimationFrame(smokeLoop);
  }

  function updateAndDrawRings() {
    for (let i = ringParticles.length - 1; i >= 0; i--) {
      const p = ringParticles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.r += 0.45;
      p.vy *= 0.99;
      p.vx *= 0.99;
      p.life -= 1;
      const t = 1 - p.life / p.maxLife;
      p.alpha = Math.max(0, 1 - t * 1.1);
      p.lineWidth = Math.max(0.5, 2.5 - t * 2);

      if (p.life <= 0 || p.r >= p.rMax) {
        ringParticles.splice(i, 1);
        continue;
      }

      // 画圆环
      smokeCtx.globalAlpha = p.alpha * 0.85;
      smokeCtx.strokeStyle = '#e8e8e8';
      smokeCtx.lineWidth = p.lineWidth;
      smokeCtx.beginPath();
      smokeCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      smokeCtx.stroke();
      // 内圈淡填充 (厚度感)
      smokeCtx.globalAlpha = p.alpha * 0.15;
      smokeCtx.fillStyle = '#ffffff';
      smokeCtx.beginPath();
      smokeCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      smokeCtx.fill();
    }
    smokeCtx.globalAlpha = 1;
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

  /* ============================================================
     吐烟圈: 真实感烟圈
     - 不规则形状: 32 个控制点围绕中心, 每个点带随机径向偏移
     - 大小不均: 环的不同段粗细不同
     - 颜色不均: 灰白相间, 不同段不同 alpha
     - 大体是个圆
     - 从小到大、从深到浅、向上漂散, 1.5 秒消失
     ============================================================ */
  function blowRing() {
    if (state !== 'lit') return;
    updateEmberScreenPos();
    // 32 个控制点 (360°/32 = 11.25°/点)
    const SEGMENTS = 32;
    const ring = {
      x: emberScreenX,
      y: emberScreenY - 4,
      r: 4,
      rMax: 34,
      vx: (Math.random() - 0.5) * 0.25,
      vy: -0.7 - Math.random() * 0.35,
      life: 90,
      maxLife: 90,
      // 预生成每个段的: 角度 + 径向偏移系数 + 颜色亮度 + 粗细
      segments: [],
    };
    for (let s = 0; s < SEGMENTS; s++) {
      ring.segments.push({
        angle: (s / SEGMENTS) * Math.PI * 2,
        // 0.7 ~ 1.25 (控制点距离中心的倍数, 让圈不规则)
        radial: 0.75 + Math.random() * 0.5,
        // 0.3 ~ 1.0 段亮度 (灰白混合)
        brightness: 0.3 + Math.random() * 0.7,
        // 1.2 ~ 2.8 段粗细 (加粗)
        width: 1.2 + Math.random() * 1.6,
      });
    }
    ringParticles.push(ring);
  }

  function drawRings() {
    // 烟圈和烟雾共用 smokeLoop, 这里不重复画 (避免清屏错位)
  }

  /* 烟圈绘制 - 实际在 smokeLoop 里调用 updateAndDrawRings */
  function updateAndDrawRings() {
    for (let i = ringParticles.length - 1; i >= 0; i--) {
      const p = ringParticles[i];

      // 物理更新
      p.x += p.vx;
      p.y += p.vy;
      p.r += 0.42;
      p.vy *= 0.992;
      p.vx *= 0.992;
      p.life -= 1;

      const t = 1 - p.life / p.maxLife;       // 0 -> 1
      p.alpha = Math.max(0, 1 - t * 1.05);   // 1 -> 0
      // 微微变形 (径向偏移也慢慢变, 显得更自然)
      for (const s of p.segments) {
        s.angle += (Math.random() - 0.5) * 0.02;  // 角度微微抖动
      }

      if (p.life <= 0 || p.r >= p.rMax) {
        ringParticles.splice(i, 1);
        continue;
      }

      // 画不规则圈: 用 quadraticCurveTo 连 32 个控制点
      const baseR = p.r;
      const SEG = p.segments.length;
      // 计算每个控制点位置
      const points = p.segments.map(s => ({
        x: p.x + Math.cos(s.angle) * baseR * s.radial,
        y: p.y + Math.sin(s.angle) * baseR * s.radial,
        brightness: s.brightness,
        width: s.width,
        angle: s.angle,
        radial: s.radial,
      }));

      // 按"段"画: 32 段, 每段单独描边粗细 + 颜色
      for (let s = 0; s < SEG; s++) {
        const cur = points[s];
        const next = points[(s + 1) % SEG];
        // 中点 (用 midpoint, 二次曲线)
        const midX = (cur.x + next.x) / 2;
        const midY = (cur.y + next.y) / 2;

        const segAlpha = p.alpha * cur.brightness;
        if (segAlpha <= 0.02) continue;

        // 段颜色: 亮段偏白, 暗段偏深灰 (加深)
        const gr = Math.floor(120 + cur.brightness * 100);  // 120~220
        smokeCtx.strokeStyle = `rgb(${gr},${gr},${gr})`;
        smokeCtx.globalAlpha = segAlpha * 0.95;             // 0.85 -> 0.95 (加深透明度)
        smokeCtx.lineWidth = cur.width * (1 - t * 0.3);     // 越后面越细 (衰减 0.4 -> 0.3, 维持粗度更久)
        smokeCtx.lineCap = 'round';

        smokeCtx.beginPath();
        smokeCtx.moveTo(cur.x, cur.y);
        smokeCtx.quadraticCurveTo(cur.x, cur.y, midX, midY);
        smokeCtx.stroke();
      }

      // 内圈淡淡的雾 (让圈有"厚度"感, 整体偏深)
      smokeCtx.globalAlpha = p.alpha * 0.14;               // 0.08 -> 0.14
      smokeCtx.fillStyle = '#ffffff';
      smokeCtx.beginPath();
      // 用控制点画一个不规则多边形
      smokeCtx.moveTo(points[0].x, points[0].y);
      for (let s = 1; s < SEG; s++) {
        smokeCtx.lineTo(points[s].x, points[s].y);
      }
      smokeCtx.closePath();
      smokeCtx.fill();
    }
    smokeCtx.globalAlpha = 1;
  }

  window.Cigarette = { init, ignite, getState, blowRing };
})();
