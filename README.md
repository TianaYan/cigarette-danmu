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
