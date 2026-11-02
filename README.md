# 同词相遇 · Word Meet

双人在线联想游戏。两人分别输入词语，提交后同时揭晓，再结合上轮两个词继续联想，直到词语相同。

> 本项目 fork 自 [CSQ-AN94/word-meet](https://github.com/CSQ-AN94/word-meet)（作者 Siqi Cai），沿用其玩法与界面，把联机后端从 Supabase 换成了阿里云 ESA 边缘函数。上游仓库未声明许可证，来源与权利归属见 [NOTICE.md](NOTICE.md)。

部署在阿里云 ESA：网页和房间后端打包进同一个边缘函数，存储用边缘 KV，不需要源站服务器。[ESA 部署步骤](docs/esa-setup.md)

## 开始游戏

1. 一人输入昵称并创建房间，复制邀请链接或房间码给另一人。
2. 另一人打开链接，或在“加入房间”中输入房间码。
3. 每轮分别输入 1–20 字的词语，点击“锁定词语”。双方提交后同时揭晓。
4. 词语不同则继续联想；双方准备后开始下一轮。相同即成功，显示「本局总览」：按轮次连接两人的词语，最后汇合到相同的词。双方确认后可以再来一局。

「对局记录」和结束后的「本局总览」只保留当前这一局。刷新、离开或开始新局会清空，暂不提供历史对局存档。

去掉首尾空格并做 Unicode NFC 规范化后严格比较；大小写、标点和词内空格仍算不同。昵称最多 12 字。

## 联机方式

整个应用是一个 ESA 边缘函数：浏览器打开网站域名，`POST /api/room` 就从同一个边缘函数走房间协议，网页资源也从同一个函数返回。两个浏览器分别访问同一个域名，不要求相同设备或 Wi-Fi。回合制消息使用短轮询，不依赖 WebRTC、NAT 穿透、第三方 Cookie 或 WebSocket。

- 房间最多两人；边缘存储没有事务，并发加入靠乐观锁重试，仍保证只有一个客人拿到席位。
- 临时断网自动重试，待发送消息按顺序去重，本轮已提交的词语保留。
- 游戏时保持页面打开。刷新或手动重新加入会开始新局；原客人可凭本页令牌立即重入。浏览器被直接终止时，客人席位在约 90 秒无活动后可重新加入。
- 房间两小时无访问即失效；房主主动离开会关闭房间并删除消息。
- 使用带随机盐的 SHA-256 承诺值锁词；双方锁定后才交换词语原文并校验。
- 房间数据存在账号下的私有边缘 KV 里，只有带席位令牌的请求能读写自己所在的房间。玩游戏的人不需要注册任何账号，浏览器里也没有任何密钥。

免费额度以 [ESA 定价](https://www.aliyun.com/product/esa) 为准：边缘函数免费版每天 10 万次请求，超出会返回 5XX，长期多人玩需要升级付费版。

## 本地检查

需要 Node.js 22.13 或以上版本。整个项目没有第三方运行依赖。

```sh
npm ci --ignore-scripts
npm test
npm run dev
```

开发预览仅监听本机，`/api/room` 用同一份房间协议的内存存储实现，直接就能联机测试，不需要任何云服务账户。自动化测试覆盖房间协议、真实 HTTP 双人对局、网络恢复和打包产物。

```sh
npm run build:esa
```

生成 `dist/esa/worker.js`：把网页资源、`server/protocol.mjs` 房间协议和 `edge/worker.mjs` 边缘函数打包成的单个文件，粘贴进 ESA 控制台即可上线。`npm run dev` / `npm run preview` 也可以直接预览 `dist/`。

## 文件与发布

- `src/game.js`：提交、揭晓、胜利与准备协议。
- `src/room.js`：`/api/room` 请求、顺序发送、轮询回显确认及自动恢复。
- `src/config.js`：房间接口地址，默认与网页同源。
- `server/protocol.mjs`：房间协议（create/join/poll/messages/leave），纯 JavaScript，本地与边缘函数共用。
- `edge/worker.mjs`：ESA 边缘函数入口，`/api/room` 走协议 + Tablestore，其余路径返回内联静态资源。
- `edge/ots.mjs`：零依赖的 Tablestore HTTP 客户端（手写签名与 PlainBuffer 编码）。
- `src/host.js`：把 `xn--` 域名解回中文，仅用于展示邀请链接。
- `test/`：房间协议、HTTP 双人对局、网络恢复、配置校验与打包产物测试。

发布流程：`npm run build:esa` → ESA 控制台粘贴 `dist/esa/worker.js` → 生成版本 → 发布到生产环境 → 绑定域名路由。详见 [接入步骤](docs/esa-setup.md)。旧版房间码不迁移，两人应刷新网页并重新建房。

## 来源与许可

本仓库是 [CSQ-AN94/word-meet](https://github.com/CSQ-AN94/word-meet) 的 fork，原作者 Siqi Cai。玩法、界面与对局协议来自上游；联机后端替换为阿里云 ESA 边缘函数 + Tablestore。

**上游仓库没有 LICENSE 文件**，GitHub 也识别不出许可证，按默认规则属保留所有权利。本项目保留上游提交历史并在页面署名，但这不构成再许可。完整说明见 [NOTICE.md](NOTICE.md)。
