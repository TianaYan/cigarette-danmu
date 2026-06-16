// Cloudflare Worker: cigarette-danmu (回滚版,不用 Durable Object)
// 路由:
//   GET  /api/messages?limit=N     - 拉历史弹幕 (KV)
//   POST /api/messages             - 发弹幕 -> 存 KV + 内存广播
//   WS   /ws                       - 实时双向,内存广播(单实例)
// 注: 内存广播只在单实例有效;多实例部署时会"同实例邻居可见,跨实例看不到"。
//     这是回滚版,优先保证服务可用。DO 版本见 git history。

const MAX_LEN = 40;
const HISTORY_MAX = 100;
const RATE_LIMIT_MS = 5000;

const KV_KEY = 'danmu:list';
const RATE_KEY = (ip) => 'rl:' + ip;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// 单实例内存广播。Worker 扩容到多实例时,各实例 hub 互相不可见,
// 跨实例用户会看不到对方弹幕,但同实例邻居能看到。
// 用一个模块级 Set 维持所有 WS 连接。
const hub = {
  sockets: new Set(),
  add(ws) { this.sockets.add(ws); this.broadcast({ type: 'online', count: this.sockets.size }); },
  remove(ws) {
    this.sockets.delete(ws);
    try { ws.close(1000, 'closing'); } catch {}
    this.broadcast({ type: 'online', count: this.sockets.size });
  },
  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.sockets) {
      try { ws.send(data); } catch {}
    }
  },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/ws') {
      return handleWS(request, env);
    }

    if (url.pathname === '/api/messages') {
      if (request.method === 'GET') {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), HISTORY_MAX);
        const list = (await env.DANMU.get(KV_KEY, { type: 'json' })) || [];
        return json(list.slice(-limit));
      }
      if (request.method === 'POST') {
        return postMessage(request, env);
      }
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }

    if (url.pathname === '/healthz') {
      return new Response('ok', { status: 200, headers: CORS });
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },
};

async function postMessage(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();

  const last = await env.DANMU.get(RATE_KEY(ip));
  if (last && now - parseInt(last, 10) < RATE_LIMIT_MS) {
    return json({ error: 'rate_limited' }, 429);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'invalid_json' }, 400); }
  const text = (body?.text || '').toString().trim();
  if (!text) return json({ error: 'empty' }, 400);
  if (text.length > MAX_LEN) return json({ error: 'too_long' }, 400);
  if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(text)) {
    return json({ error: 'no_meaningful_content' }, 400);
  }

  const msg = {
    id: 'm_' + Math.random().toString(36).slice(2, 10) + now.toString(36),
    text,
    ts: now,
  };

  const list = (await env.DANMU.get(KV_KEY, { type: 'json' })) || [];
  list.push(msg);
  if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX);
  await env.DANMU.put(KV_KEY, JSON.stringify(list));
  await env.DANMU.put(RATE_KEY(ip), String(now), { expirationTtl: 60 });

  // 内存广播
  hub.broadcast({ type: 'message', data: msg });

  return json({ ok: true, id: msg.id });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function handleWS(request, env) {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected websocket', { status: 426, headers: CORS });
  }
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];

  server.accept();
  hub.add(server);

  // ★ 新增: 监听客户端发来的消息
  // 客户端发的是 { type: 'send', data: { text, ... } }
  // 我们把校验 + 存 KV + 广播 复用 POST 那条逻辑
  server.addEventListener('message', async (ev) => {
    let payload;
    try { payload = JSON.parse(ev.data); } catch { return; }
    if (payload?.type !== 'send' || !payload?.data?.text) return;

    const text = String(payload.data.text).trim();
    if (!text) return;
    if (text.length > MAX_LEN) return;
    if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(text)) return;

    const now = Date.now();
    const msg = {
      id: 'm_' + Math.random().toString(36).slice(2, 10) + now.toString(36),
      text,
      ts: now,
    };

    // 存 KV (复用 postMessage 的存逻辑)
    const list = (await env.DANMU.get(KV_KEY, { type: 'json' })) || [];
    list.push(msg);
    if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX);
    await env.DANMU.put(KV_KEY, JSON.stringify(list));

    // 广播给同实例所有 WS 客户端
    hub.broadcast({ type: 'message', data: msg });
  });

  // 注意:这里不监听 close 事件,因为加 listener 会让 hub.remove 二次 close
  const cleanup = () => hub.remove(server);
  server.addEventListener('close', cleanup);
  server.addEventListener('error', cleanup);

  // 30s 心跳
  const ping = setInterval(() => {
    try { server.send(JSON.stringify({ type: 'ping', ts: Date.now() })); }
    catch { clearInterval(ping); }
  }, 30000);

  return new Response(null, { status: 101, webSocket: client });
}
