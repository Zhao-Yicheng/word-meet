# 阿里云 ESA 部署

整个游戏（网页 + 房间后端）打包成一个 ESA 边缘函数，存储用边缘 KV，**不需要源站服务器**。

## 1. 开通 ESA 并接入域名

1. 登录 [ESA 控制台](https://esa.console.aliyun.com/)，新增站点，填入你要用的域名（例如 `word-meet.example.com`）。第一次使用可以在 [阿里云试用中心](https://try.aliyun.com/) 领取 ESA 试用资格。
2. 接入方式选 **CNAME**，按提示完成域名归属权验证（添加一条 `_esaauth` 的 TXT 记录）。
3. 在 **SSL/TLS > 边缘证书** 开启免费证书，后续访问全部走 HTTPS。

## 2. 创建边缘 KV 命名空间

左侧导航 **边缘计算和 AI > KV存储**，创建存储空间，名称填 `word-meet`（函数代码里写死了这个名字，要改的话编辑 `edge/worker.mjs` 里的 `KV_NAMESPACE` 后重新打包）。

## 3. 打包函数

```sh
npm ci --ignore-scripts
npm run build:esa
```

生成 `dist/esa/worker.js`（约 100 KB 的单文件，含全部网页资源和房间协议，远低于 ESA 函数 4 MB 代码上限）。整个项目没有第三方运行依赖，也不需要数据库。

## 4. 创建并发布函数

1. 控制台 **边缘计算和 AI > 函数和Pages** → 创建函数，选自定义函数。函数名只能包含小写字母、数字和中划线，例如 `word-meet`。**规格建议选 50ms**（默认 5ms 在解析房间 JSON 时可能被 CPU 时间片截断）。
2. 进入函数详情的 **代码** 页签，把 `dist/esa/worker.js` 的全部内容粘贴进编辑器，保存。控制台右侧可以构造请求调试：
   - POST `/api/room`，Body `{"action":"health"}`，应返回 `{"ok":true,"transport":"esa","protocol":3}`。
3. 点击 **生成版本**，切换到 **部署** 页签，把该版本**发布到生产环境**。
4. 回到 **触发器/路由** 配置，把函数绑定到站点域名，路由规则匹配 `/*`（网页和 API 都走同一个函数）。也可以绑到子域名，例如 `play.example.com/*`。

> 创建函数后会得到一个 60 分钟有效的临时预览域名，可以直接先验证再绑域名。

## 5. 线上验证

```sh
curl -X POST https://你的域名/api/room -H 'Content-Type: application/json' -d '{"action":"health"}'
```

然后两个浏览器打开 `https://你的域名/`，创建房间、用邀请链接加入，完成「月亮 / 兔子 → 玉兔 / 玉兔」两轮即验证成功。

## 工作原理与限制

- 网页和 `/api/room` 在同一个边缘函数里：浏览器只和自己的域名通信，默认同源，不需要额外配置跨域（接口仍返回 CORS 头，方便单独调试）。
- 房间状态保存在边缘 KV 的单个 JSON 文档（`room-<房间码>`）。**KV 没有事务和 CAS**：原 Supabase 版本用 PostgreSQL 行锁串行化并发加入，ESA 版本改为「读取 → 修改 → 写回 → 校验 writeId → 冲突重试」的乐观锁，客户端再通过轮询回显确认消息已持久化，极端并发下也能收敛。
- 轮询间隔 1.5 秒（标签页隐藏时 3 秒）。边缘函数免费版每天 10 万次请求（超出会返回 5XX）；双人玩一整天约 11 万次，正常对局远低于此。长期多人玩请升级付费版（5 元/百万次）。
- KV 计费：读 0.7 元/百万次、写 6.5 元/百万次。心跳写入做了 15 秒节流，一局游戏通常只有几十次写。
- 房主退出会删除房间；过期房间（两小时无访问）在 KV 里残留下次建房也不会清理。需要清理时用 [ESA OpenAPI](https://help.aliyun.com/zh/edge-security-acceleration/esa/) 的 `ListKvs` + `BatchDeleteKv`。
- 不支持 WebSocket：本来就一直用 HTTPS 短轮询，兼容边缘函数。
