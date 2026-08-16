# dsh-token-stats — Token 用量统计

在设置页统计 DSH 的 Token 用量：**累计总量、今日用量、按模型分解、按天分解、日期区间查询**，
另注册 `token_stats` 模型工具供对话中直接查询。

## 功能

- **累计总 tokens**：全部会话（含子代理与 Goal 轮次）的提供方上报用量合计。
- **今日用量**：当天 0 点起的用量卡片。
- **按模型分解**：各模型的请求数、输入 / 输出 / 缓存读 / 缓存写 / 推理 token 与占比条。
- **按天分解**：逐日用量表 + 近 7 天柱状图。
- **日期查询**：起止日期选择（今天 / 近 7 天 / 近 30 天 / 全部 快捷按钮），区间内总量、按模型、按天。
- **token_stats 工具**：模型在对话中可直接查询用量统计。

### 数据口径

- 按官方记账约定捕获：每步骤的 `assistant/chunk { type: 'usage' }` 用量分片；
  同一步骤最终 `assistant/message.usage` 替换样本（不重复计数）。
- 模型归属来自会话的 `request/header` 快照（provider / model）。
- 合计 = 输入 + 输出 + 缓存读 + 缓存写；推理是输出的细分项，不重复计入。
- 只统计提供方上报了用量的调用；失败的模型请求不产生样本。

## 安装

### 方式一：从 GitHub 安装（推荐）

仓库内已包含预构建的 `lib/`，无需构建脚本。建议锁定 commit，避免远端推送
静默改变安装内容（`#<sha>` 是硬锁）：

```sh
dsh plugin --profile web add github:JayhaShf/dsh-token-stats#<commit-sha>
```

> 发布新版本时，把 `<commit-sha>` 替换为 `git rev-parse HEAD` 的实际提交哈希。

### 方式二：tarball 安装

在仓库根目录执行 `pnpm pack` 生成 tarball 后：

```sh
dsh plugin --profile web add ./dsh-token-stats-0.1.0.tgz
```

### 方式三：本地目录安装（仅限开发调试）

```sh
# 1. 安装插件自身依赖（schemastery 及其传递依赖，使插件目录可独立解析）
npm install        # 在 dsh-token-stats 目录内执行

# 2. 装入 profile
dsh plugin --profile web add ./dsh-token-stats

# 3. 重启 dsh web 后生效
```

> `dsh plugin add` 以 `link:` 协议链接本地插件目录，不会自动安装插件声明的依赖；
> 缺少时 Node 无法解析 `@deepseek-ai/schemastery`（报"缺失的依赖"）。在插件目录
> 执行 `npm install` 即可补齐（本地 link 模式下有效；npm 打包发布时依赖由
> package.json 声明，安装方自行解析）。

## 跨平台支持

插件只使用 Node.js 标准库与跨平台路径 API（`os.homedir()` / `node:path`），
不依赖任何平台特定命令。GitHub Actions CI 会在 **Ubuntu / Windows / macOS**
三个系统上执行：

1. `npm test` 源码自测；
2. `pnpm pack` 打 tarball；
3. 在全新 `DSH_HOME` 的干净 profile 中 `dsh plugin add` 安装 tarball；
4. 再对已安装产物运行一次自测，验证打包和安装链路。

## 配置（cordis.yml 可覆盖）

| 键 | 默认值 | 说明 |
|---|---|---|
| `dataDir` | `$DSH_HOME/storages/dsh-token-stats` | 用量 JSONL 存放目录（`usage.jsonl`，仅追加，重启自动恢复） |
| `retentionDays` | `0` | 保留天数；`0` 永久保留，`>0` 时加载 / 采集 / 查询都按天数裁剪 |
| `flushDelayMs` | `2000` | 采集样本批量落盘防抖窗口 |

## 数据文件

`<dataDir>/usage.jsonl` 每行一个样本：

```json
{"key":"sess-1:1:0","sessionId":"sess-1","turn":1,"step":0,"provider":"deepseek","model":"deepseek-v4-flash","time":1755300000000,"inputTokens":100,"outputTokens":50,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"source":"message"}
```

删除该文件即清空全部统计（下次启动重建）。

## HTTP 接口（浏览器同源）

- `GET /tokens-api/stats` — 累计 / 今日 / 按模型 / 按天。
- `GET /tokens-api/stats?from=YYYY-MM-DD&to=YYYY-MM-DD` — 追加区间统计。
- `GET /tokens-api/ping` — 存活探测。

## 开发

```sh
npm install
npm test
```
