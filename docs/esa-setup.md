# 阿里云 ESA 部署

整个游戏（网页 + 房间后端）是一个 ESA 边缘函数，**不需要源站服务器**。
房间状态存在 Tablestore（表格存储），密钥由 ESA「函数变量」注入，不进仓库。

## 架构

| 部分 | 实现 |
| --- | --- |
| 静态资源 | 构建时内联进函数，`/`、`/src/*.js`、`/src/style.css` 直接返回 |
| 房间协议 | `server/protocol.mjs`，POST `/api/room` |
| 状态存储 | Tablestore（`rooms` 表，主键 `code` STRING，列 `data` 存整份房间 JSON） |
| OTS 客户端 | `edge/ots.mjs`，零依赖手写（V2 HMAC-SHA1 签名 + PlainBuffer 行编码 + 最小 Protobuf） |
| 密钥 | ESA 控制台「函数变量」（AK/SK 勾选加密存储），运行时从 `env` 读 |

为什么不用 ESA 自带的 Edge KV：它最终一致，实测写入后要 **11–303 秒**才可见，做不了房间这种强一致读写；OTS 单次读在边缘侧只要 **5–20ms**。

## 1. 创建 Tablestore 实例

**地域要和边缘节点同域**。本项目域名没有备案，ESA 只从香港节点服务，所以实例选 **中国香港**（若选上海就变成跨境回源，单次读 200–2600ms）。

1. [OTS 控制台](https://otsnext.console.aliyun.com/) 切到 `中国香港`，创建实例：CU 模式（按量）、高性能型、同城冗余，实例名例如 `word-meet-hk`。
2. 实例 → **网络管理** → 编辑 → 勾选 **公网** → 保存。不勾会报 `OTSAuthFailed: Request denied by instance ACL policies`。
3. 实例 → **创建数据表**：表名 `rooms`，表主键一个 `code`，类型 **字符串**。

## 2. 创建 AccessKey

RAM 控制台 → 访问密钥 → 创建 AccessKey。密钥只显示一次，直接填进下一步的变量，**不要写进代码或提交**。

## 3. 配置函数变量

ESA 控制台 → 函数和 Pages → `word-meet` → **基本信息** → 函数变量 → 生产环境，添加：

| 键 | 值 | 加密 |
| --- | --- | --- |
| `OTS_ENDPOINT` | `https://word-meet-hk.cn-hongkong.ots.aliyuncs.com` | 否 |
| `OTS_INSTANCE` | `word-meet-hk` | 否 |
| `OTS_ACCESS_KEY_ID` | AccessKey ID | 是 |
| `OTS_ACCESS_KEY_SECRET` | AccessKey Secret | 是 |
| `OTS_TABLE` | `rooms`（可省略，默认即 rooms） | 否 |

> 变量改动**不会立刻作用于线上**，要重新构建并发布一个新版本才生效。

## 4. 构建与部署

项目已接入 GitHub 自动构建：推送 `main` 即触发构建并发布到生产。

- 安装命令 `npm install`
- 构建命令 `npm run build:esa`
- 函数文件路径 `dist/esa/worker.js`

本地等价命令：

```sh
npm ci --ignore-scripts
npm run build:esa   # 生成 dist/esa/worker.js，单文件、无 import、约 120 KB
```

## 5. 线上验证

```sh
# 变量是否注入成功（只回布尔值，不回显密钥）
curl -X POST https://你的域名/api/room -H 'Content-Type: application/json' -d '{"action":"diagnose"}'
# → {"hasEndpoint":true,...,"storeReady":true,"readOk":true,"readMs":8}

# 存储连通性
curl -X POST https://你的域名/api/room -H 'Content-Type: application/json' -d '{"action":"health"}'
# → {"ok":true,"transport":"esa","protocol":3}
```

然后两个浏览器打开站点，创建房间、用邀请链接加入，走完两轮即验证成功。

## 工作原理与限制

- 网页和 `/api/room` 在同一个边缘函数里：浏览器只和自己的域名通信，默认同源（接口仍返回 CORS 头，方便单独调试）。
- 每次写操作是「读 → 改 → 写」；OTS 强一致，写完立刻可读，不需要原来的 writeId 校验重试，所以 `createRoomApi` 传 `verifyWrites: false` 省掉一次读。
- 轮询间隔 1.5 秒（标签页隐藏时 3 秒）。一局游戏通常只有几十次读写。
- 不支持 WebSocket：本来就一直用 HTTPS 短轮询，兼容边缘函数。

## 常见问题

- **本地 DNS 解析不到 OTS 域名**：家用路由器 DNS 常常解析失败，用 `nslookup <host> 223.5.5.5` 拿 IP，或直接在边缘侧验证；边缘网络的 DNS 正常。
- **`env` 读不到变量**：ESA 的 `env` 是 `fetch(request, context, env)` 的**第三个**参数，不是第二个；且 `env` 惰性解析，只能直接读 `env.KEY`，不能用 `Object.keys` 枚举。
- **`OTSParameterInvalid: TimeToLive cannot be less than 86400`**：建表 TTL 最小 1 天。
- **`No version condition is specified`**：GetRow 必须带 `max_versions`。
- **`Delete marker is missing while deleting row`**：DeleteRow 的行缓冲要比 GetRow 多一个删除标记（tag `0x08`）。
- **公网下行会产生流量费**：房间数据只有几 KB，实际开销可忽略。
