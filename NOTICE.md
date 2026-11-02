# 来源与版权说明 / Notice

## 上游项目

本仓库是下列项目的 fork：

- **仓库**：[CSQ-AN94/word-meet](https://github.com/CSQ-AN94/word-meet)
- **作者**：Siqi Cai（[@CSQ-AN94](https://github.com/CSQ-AN94)）
- **首版提交**：2026-10-31 `Build Word Meet two-player online association game`

游戏玩法、界面设计、文案、`src/game.js` 的对局协议与 `src/style.css` 的视觉方案均来自上游项目，版权归原作者所有。

## 上游的许可状况

**上游仓库目前没有 LICENSE 文件**，GitHub 也无法为其识别出许可证（`GET /repos/CSQ-AN94/word-meet/license` 返回 404）。

按伯尔尼公约与 GitHub 服务条款的默认规则，未声明许可证的公开仓库属于**保留所有权利**：公开可见不等于授权复制、修改或再分发。本仓库保留上游的完整提交历史（原作者的 8 次提交都在 `git log` 里，作者信息未被改写），并在页面和文档中显著署名，但这不构成对上游的再许可，也不能替代原作者本人的授权。

如果原作者对此有任何异议，或希望补充明确的许可证，请在本仓库开 issue，我会立即配合调整或下线部署。

## 本仓库做了什么

在保留上游玩法的前提下，把联机后端从 Supabase 换成了阿里云 ESA 边缘函数：

| 方面 | 上游 | 本 fork |
| --- | --- | --- |
| 网页托管 | GitHub Pages | 同一个 ESA 边缘函数（内联资源） |
| 房间后端 | Supabase PostgreSQL RPC | ESA 边缘函数 + Tablestore（香港） |
| 联机协议 | 短轮询 | 短轮询（协议基本沿用上游） |
| 新增文件 | — | `edge/worker.mjs`、`edge/ots.mjs`、`src/host.js`、`scripts/buildesa.mjs`、`docs/esa-setup.md` |
| 移除文件 | `supabase/setup.sql` | — |

详见 [`docs/esa-setup.md`](docs/esa-setup.md)。

## 商标与署名

「同词相遇 / Word Meet」名称与视觉标识沿用上游。页脚署名链接指向上游仓库，请勿移除。
