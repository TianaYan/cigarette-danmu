# 一根烟 · 匿名弹幕 - Supabase + GitHub Pages 版

> 国内可访问的"实时弹幕同步"实现:
> - 前端: GitHub Pages 静态托管(免费)
> - 后端: Supabase(免费 Postgres + Realtime 实时推送)
> - 弹幕 1 秒内同步到所有在线用户
> - 完全免费,国内可访问

## 文件清单

```
index.html       页面骨架(已加 Supabase SDK CDN)
config.js        Supabase URL / anon key (已填好你的)
cigarette.js     烟状态机
danmu.js         弹幕层(Supabase Realtime 订阅)
app.js           入口
styles.css       深色主题样式
```

## 部署到 GitHub Pages

### 1. 准备 GitHub 仓库

1. 注册/登录 https://github.com
2. 顶部 **"+"** → **"New repository"**
   - Name: `cigarette-danmu`
   - Public(必须,GitHub Pages 免费版要求公开)
   - **不要勾** Add README
   - 点 Create repository

### 2. 上传代码

打开 PowerShell:

```powershell
cd 解压目录

git init
git add .
git commit -m "init"

# 把下面的 YOUR-USERNAME 换成你的 GitHub 用户名
git remote add origin https://github.com/YOUR-USERNAME/cigarette-danmu.git
git branch -M main
git push -u origin main
```

输入 GitHub 用户名密码(或 Personal Access Token)即可。

### 3. 开启 Pages

1. 打开 https://github.com/YOUR-USERNAME/cigarette-danmu
2. 顶部 **Settings** → 左侧 **Pages**
3. Source: **Deploy from a branch**
4. Branch: **main**, / (root)
5. 点 Save

等 1-2 分钟,会显示:
```
Your site is live at https://YOUR-USERNAME.github.io/cigarette-danmu/
```

### 4. Supabase 表创建

如果还没建:

1. https://supabase.com/dashboard 选你的项目
2. 左侧 **Table Editor** → New table
3. Name: `messages`, 勾 **Enable Realtime**
4. 列:
   - `id` bigint (主键 auto) — 默认有
   - `created_at` timestamptz (默认 now()) — 默认有
   - `text` text (必填)
5. Save

### 5. 启用 Realtime

左侧 **Database** → **Replication** → 找到 `messages` 表 → **勾上** → Save

### 6. 测试

打开 `https://YOUR-USERNAME.github.io/cigarette-danmu/`

发消息,开另一个浏览器窗口(或让朋友打开),**应该 1 秒内看到对方弹幕飘过去**。

## 安全提示

你贴聊天里的 anon/publishable key 是给前端用的——理论上**公开安全**(RST)。但稳妥起见:
- 部署完上线后,去 Supabase 控制台 **rotate 这个 key**
- 把新 key 发我,我帮你更新 config.js

## 限制

| 项 | 免费额度 | 你的项目够用 |
|---|---|---|
| 数据库 | 500MB | 50万条消息够用 |
| Realtime 消息 | 200万/月 | 足够 |
| 带宽 | 5GB/月 | 够 |

## 故障排查

**A. 页面打开但 console 报 `supabase is not defined`**
- 检查 CDN 加载,可能需要 `cdn.jsdelivr.net` 在国内被拦
- 备用 CDN: `https://unpkg.com/@supabase/supabase-js@2`

**B. 发消息成功但对方看不到**
- 检查 Database → Replication 里 `messages` 表**勾上**了没
- 检查 RLS 策略: 如果启用了 RLS,默认拒绝所有
  - Database → Policies → 给 messages 表加 "Enable insert for all" 和 "Enable select for all"

**C. GitHub Pages 国内访问慢**
- 正常。GitHub Pages 在国内本来就慢。你朋友在境外应该没问题。
- 你自己本地想测试: 双击 `index.html` 用浏览器打开(本地 file:// 也能跑)
