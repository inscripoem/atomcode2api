# atomcode2api

将 AtomCode CodingPlan 的免费 LLM 额度包装为 OpenAI 兼容 API。

**零构建** — Bun 单文件，无编译步骤。**零签名** — 走 CodingPlan 直接端点，不需要闭源 HMAC。

## 快速开始

```bash
bun install
bun run dev
```

浏览器打开 `http://localhost:3456/login`，完成 AtomGit OAuth 登录。

## 使用

任何 OpenAI 兼容客户端，配置：

| 字段 | 值 |
|------|-----|
| Base URL | `http://localhost:3456/v1` |
| API Key | 留空（或设 `API_KEY` 环境变量后填对应值） |
| Model | `deepseek-v4-flash` / `Qwen/Qwen3-VL-8B-Instruct` / `glm-5` |

```bash
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hello"}],"stream":false}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:3456/v1", api_key="any")
client.chat.completions.create(model="deepseek-v4-flash", messages=[{"role":"user","content":"hello"}])
```

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/chat/completions` | 聊天补全（支持 SSE streaming） |
| GET | `/v1/models` | 可用模型列表 |
| GET | `/v1/usage` | 配额用量 |
| GET | `/health` | 健康检查 |
| GET | `/login` | OAuth 登录页 |
| GET | `/api/auth/status` | 认证状态 |
| GET/PATCH | `/api/config` | 运行配置 |
| GET | `/api/codingplan/status` | CodingPlan 原始状态 |
| POST | `/api/codingplan/claim` | 领取计划 |
| POST | `/api/dashboard/login` | Dashboard 密码登录 |

## Dashboard

`http://localhost:3456` — 内建管理面板：

- 用量仪表盘 + 配额进度条
- 可用模型列表
- Playground 在线测试
- Pro 自动领取开关
- Webhook 告警设置

**访问认证**：设置 `DASHBOARD_PASSWORD` 环境变量后，访问 Dashboard 需输入密码。登录态通过 HttpOnly Cookie 保持，有效期 24 小时。未设置时 Dashboard 完全开放（向后兼容）。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `3456` | 监听端口 |
| `API_KEY` | 空 | 设置后 `/v1/*` 需要 `Bearer <key>` 鉴权 |
| `AUTO_CLAIM_PRO` | `false` | 每天 10:00 BJT 自动抢 Pro |
| `MONITOR_INTERVAL` | `300000` | 用量检查间隔 (ms)，0=禁用 |
| `MONITOR_WEBHOOK` | 空 | 用量超阈值时 POST 告警的 URL |
| `MONITOR_WARN_PERCENT` | `80` | 告警触发百分比 |
| `ATOMCODE_PLATFORM_SERVER` | `https://acs.atomgit.com` | OAuth 平台地址 |
| `DASHBOARD_PASSWORD` | 空 | 设置后 Dashboard 需密码登录 |
| `LOG_LEVEL` | `info` | 日志级别：`trace` / `debug` / `info` / `warn` / `error` |

## 日志

基于 [pino](https://getpino.io/) 的结构化 JSON 日志：

- **控制台输出**：终端下 pretty-print 彩色输出，重定向或非 TTY 环境输出纯 JSON
- **文件输出**：`data/logs/app.log`，每日自动轮转，保留 7 天
- **请求日志**：自动记录所有 HTTP 请求的方法、路径、状态码、响应耗时

通过 `LOG_LEVEL` 环境变量控制日志级别（默认 `info`）。

## 可用模型

| 别名 | 实际模型 | 上下文 | 计划 |
|------|----------|--------|------|
| `deepseek-v4-flash` / `deepseek-v4` | `deepseek-ai/DeepSeek-V4-Flash` | 1M | Lite |
| `qwen3-vl` / `qwen-vl` | `Qwen/Qwen3-VL-8B-Instruct` | 64K | Lite |
| `glm-5` | `GLM-5.2` | 200K | Pro 限定 |

> 模型列表通过 CodingPlan API 动态获取，以 `/v1/models` 返回的为准。

## 脚本

```bash
bun run claim-pro    # 独立进程，每天 10:00 BJT 抢 Pro
bun run monitor      # 一次性健康检查，支持 --webhook 推送
```

## Docker 部署

```bash
# 复制环境变量模板
cp .env.example .env
# 编辑 .env 设置 API_KEY 等

# 启动
docker compose up -d

# 登录
open http://localhost:3456/login
```

### GitHub Container Registry

每次 push main 或打 tag 自动构建多架构镜像 (amd64 + arm64) 推送到 ghcr.io:

```bash
docker pull ghcr.io/<your-org>/atomcode2api:latest
```

## 许可证

MIT
