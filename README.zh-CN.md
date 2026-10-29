# PerfPilot

> AI 原生的桌面端性能测试平台 —— **Tauri 2 + Vue 3 + k6**。

[English](./README.md)

PerfPilot 把自然语言描述的测试场景转换成可直接运行的 k6 脚本，在 Monaco 侧编辑，配置 LLM 服务端，实时把测试输出流式回桌面端。

## 特性

- 🚀 **k6 引擎** —— 桌面端直接执行 `k6 run`，stdout/stderr 实时流到 UI。k6 已随应用打包，无需单独安装。
- 🪄 **AI 生成脚本** —— 用自然语言描述场景，得到完整的 k6 脚本（HTTP、RPS、scenario、threshold、check）。
- 🧠 **可插拔 LLM** —— OpenAI 兼容、Anthropic、Ollama，或任何自定义 OpenAI 兼容端点（DeepSeek、Moonshot、OpenRouter 等）。
- 🖥️ **Monaco 编辑器** —— 类 IntelliSense 的 k6 JavaScript 编辑、主题、多 Tab。
- 📊 **实时指标** —— 抓取 k6 summary 指标并在 app 内渲染。
- 🔐 **凭据库** —— token、账号密码、API Key、OAuth2 秘密值保存在系统凭据库，运行时按次注入 k6 环境变量；AI 只能看到变量名，永远看不到值。
- 💾 **本地优先** —— 脚本、运行记录、配置都通过 Tauri store plugin 持久化。

## 用法

### 1. 配置 LLM（设置）

打开**设置**，添加 provider（OpenAI 兼容、Anthropic 或 Ollama），选择模型并激活。API key 存放在系统凭据库（macOS 钥匙串 / Windows 凭据管理器 / Linux Secret Service），不会写入配置文件。

### 2. 不含认证的压测

1. **AI 生成** —— 用自然语言描述场景（例如 *"对 `GET /health` 做冒烟测试，20 VU 跑 30 秒，p95 超过 400ms 判失败"*），一键生成带 check 和 threshold 的完整 k6 脚本。
2. 保存脚本（默认脚本目录 `~/.perfpilot`，可在设置中修改）。
3. **实时运行** —— 选择脚本，可选填环境变量 / CLI 参数，开始运行。stdout/stderr 与汇总指标实时回流到 app。

也可以完全不用 AI，直接在 Monaco 编辑器里手写脚本。

### 3. 带认证的压测

不用把秘密值贴进 prompt 或脚本——在**凭据管理**里登记一次，PerfPilot 会在运行时注入 k6 进程环境。

| 模式 | 注入的环境变量 | 典型场景 |
| --- | --- | --- |
| Bearer Token | `AUTH_TOKEN` | 静态 API token / 会话 JWT |
| 账号 + 密码 | `AUTH_USER` + `AUTH_PASS` | HTTP Basic 认证 |
| API Key | `API_KEY`（header 名作为元数据） | `X-API-Key` 类密钥 |
| OAuth2 客户端凭据 | `OAUTH_TOKEN_URL` / `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET`（可带 `OAUTH_SCOPE`） | 机器对机器 OAuth2 |
| OAuth2 刷新令牌 | `OAUTH_TOKEN_URL` / `OAUTH_REFRESH_TOKEN`（可带 client id/secret） | 长时间压测定期刷新 token |

环境变量名每条凭据可自定义——多条 OAuth2 凭据请使用不同前缀，避免互相覆盖。

**身份池。** 一条凭据可存多个秘密值（每行一个），注入时以 `\n` 连接进同一个变量，脚本按 VU 轮转：

```js
const TOKENS = (__ENV.AUTH_TOKEN || "").split("\n").filter(Boolean);
const token = TOKENS[__VU % TOKENS.length];
```

**批量导入。** 导入对话框支持粘贴或选择文件，格式支持 `.env`、JSON、CSV。

**AI 与凭据的配合。** 每次生成请求都会自动附带凭据清单——名称、模式、环境变量名、池大小，**绝不含值**。描述场景时直接提认证方式（例如"每个 VU 用 E2E OAuth2 凭据认证"），生成的脚本就会读取对应的 `__ENV` 变量。OAuth2 的标准写法是在 `setup()` 里换一次 token：

```js
export function setup() {
  const res = http.post(
    __ENV.OAUTH_TOKEN_URL,
    `grant_type=client_credentials&client_id=${__ENV.OAUTH_CLIENT_ID}&client_secret=${__ENV.OAUTH_CLIENT_SECRET}`,
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
  );
  return { token: res.json("access_token") };
}
```

**运行时勾选。** 在**实时运行**页勾选本次需要的凭据（记住上次选择）再开始。秘密值只以环境变量注入 k6 子进程——不会出现在命令行、持久化的运行记录或界面上，LLM 也永远只能看到变量名。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 桌面壳 | **Tauri 2**（Rust） |
| UI | **Vue 3** + **TypeScript** + **Vite** |
| 状态 | **Pinia** |
| 设计系统 | **shadcn-vue / Reka UI** + **Tailwind CSS** |
| 代码编辑器 | **Monaco Editor** |
| 负载引擎 | **k6**（Tauri sidecar，已打包进应用） |
| LLM 传输 | `reqwest`（Rust）走 OpenAI 兼容 chat completions |

## 项目结构

```
perf-pilot/
├── src/                       # Vue 3 前端
├── src-tauri/                 # Rust 后端
│   └── src/
│       ├── k6.rs              # k6 运行器 + sidecar 解析
│       ├── credentials.rs     # 凭据库（系统凭据库）+ 环境变量注入
│       ├── llm.rs             # LLM 客户端
│       ├── llm_stream.rs      # SSE 流式响应解析
│       ├── fs.rs              # 脚本 / 运行记录读写
│       └── settings.rs        # 应用设置持久化
├── e2e/                       # Playwright e2e（mock Tauri IPC）
└── scripts/                   # fetch-k6.sh、build-dmg.sh
```

## 下载

去 [Releases](https://github.com/Souanine/perf-pilot/releases) 页面下载最新安装包：

| 平台 | 文件 |
| --- | --- |
| macOS Apple Silicon | `PerfPilot-0.1.5-arm64.dmg` |
| Windows x64 | `PerfPilot_0.1.5_x64-setup.exe` |

## 快速开始（开发）

```bash
npm install
scripts/fetch-k6.sh        # 拉当前 host 对应的 k6 sidecar（~60 MB，已 gitignore）
npm run tauri:dev          # 启动桌面端 app
```

本地生产构建：

```bash
npm run tauri:build        # .app（macOS）或 .exe（Windows）
npm run tauri:release-dmg  # macOS：.app + .dmg
```

跨平台发版（以及上传到 Releases）见 [CONTRIBUTING.md → Releasing](./CONTRIBUTING.md#releasing)。

## 系统要求

| 平台 | 最低 |
| --- | --- |
| macOS | 10.13+（测试环境：macOS 26 Tahoe，arm64） |
| Windows | 10 / 11 x64（NSIS 安装包） |
| Linux | x64 / arm64（k6 sidecar 已支持，暂未做 release 目标） |

仅开发时需要：

- **Rust** 1.77+
- **Node** 18+ 与 **npm** 9+

k6 已随应用打包。如需使用自定义构建，可用 `K6_PATH` 环境变量覆盖。

## 许可

MIT。详见 [`LICENSE`](./LICENSE)。

## 致谢

- [Tauri](https://tauri.app/) —— Rust + WebView 桌面壳
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) —— VS Code 同款编辑器
- [k6](https://k6.io/) —— Go 写的现代负载测试引擎