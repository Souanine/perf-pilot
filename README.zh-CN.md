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
- 💾 **本地优先** —— 脚本、运行记录、配置都通过 Tauri store plugin 持久化。

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
| macOS Apple Silicon | `PerfPilot-0.1.0-arm64.dmg` |
| Windows x64 | `PerfPilot_0.1.0_x64-setup.exe` |

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

本仓库采用 Apache-2.0 / MIT 双许可。详见 `LICENSE-APACHE-2.0` 与 `LICENSE-MIT`。

## 致谢

- [Tauri](https://tauri.app/) —— Rust + WebView 桌面壳
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) —— VS Code 同款编辑器
- [k6](https://k6.io/) —— Go 写的现代负载测试引擎