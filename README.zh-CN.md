# PerfPilot

> AI 原生的桌面端性能测试平台 —— **Tauri 2 + Vue 3 + k6**。

[English](./README.md)

PerfPilot 把自然语言描述的测试场景转换成可直接运行的 k6 脚本，在 Monaco 侧编辑，配置 LLM 服务端，实时把测试输出流式回桌面端。

## 特性

- 🚀 **k6 引擎** —— 桌面端直接执行 `k6 run`，stdout/stderr 实时流到 UI
- 🪄 **AI 生成脚本** —— 用自然语言描述场景，得到完整的 k6 脚本（HTTP、RPS、scenario、threshold、check）
- 🧠 **可插拔 LLM** —— OpenAI 兼容、Anthropic、Ollama，或任何自定义 OpenAI 兼容端点（DeepSeek、Moonshot、OpenRouter 等）
- 🖥️ **Monaco 编辑器** —— 类 IntelliSense 的 k6 JavaScript 编辑、主题、多 Tab
- 📊 **实时指标** —— 抓取 k6 summary 指标并在 app 内渲染
- 💾 **本地优先** —— 脚本、运行记录、配置都通过 Tauri store plugin 持久化

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 桌面壳 | **Tauri 2**（Rust） |
| UI | **Vue 3** + **TypeScript** + **Vite** |
| 状态 | **Pinia** |
| 设计系统 | **shadcn-vue / Reka UI** + **Tailwind CSS** |
| 代码编辑器 | **Monaco Editor** |
| 负载引擎 | **k6**（命令行，通过 Rust 调用） |
| LLM 传输 | `reqwest`（Rust）走 OpenAI 兼容 chat completions |

## 项目结构

```
perf-pilot/
├── src/                       # Vue 3 前端
│   ├── components/
│   ├── pages/
│   ├── stores/                # Pinia
│   ├── lib/                   # Tauri IPC、工具函数
│   ├── router.ts
│   └── main.ts
├── src-tauri/                 # Rust 后端
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs
│   │   ├── k6.rs              # k6 运行器
│   │   ├── llm.rs             # LLM 客户端
│   │   ├── llm_stream.rs      # SSE 流式响应解析
│   │   ├── fs.rs              # 脚本读写
│   │   └── settings.rs        # 应用设置持久化
│   ├── Cargo.toml
│   └── tauri.conf.json
├── e2e/                       # Playwright e2e（mock Tauri IPC）
├── scripts/                   # build-dmg.sh 等
└── ...
```

## 开发

```bash
npm install
scripts/fetch-k6.sh        # 把 k6 sidecar 拉到 src-tauri/binaries/（仅首次 / 升级 k6 时需要）
npm run tauri:dev          # 启动桌面端 app
```

## 生产构建

```bash
scripts/fetch-k6.sh        # 同上
npm run tauri:build        # 仅 .app
npm run tauri:release-dmg  # .app + .dmg（带 Applications 快捷方式）
```

构建产物：

| 文件 | 大小 | 备注 |
| --- | --- | --- |
| `src-tauri/target/release/bundle/macos/PerfPilot.app` | 7.9 MB | 单文件 Mach-O arm64 |
| `PerfPilot-0.1.0-arm64.dmg` | 4.9 MB | UDZO 压缩，85% 压缩率，含 Finder 布局 |

## 测试

三层测试，覆盖不同范围：

| 层级 | 命令 | 覆盖 |
| --- | --- | --- |
| Vue 组件 / Pinia store | `npm run test` | 纯逻辑；jsdom 环境 |
| Rust 后端 | `cargo test --lib`（在 `src-tauri/` 下） | k6 parser、SSE parser、index 助手函数 |
| 端到端（浏览器） | `npm run test:e2e` | 真实 Vue + Pinia + Router 跑在 Vite dev server 上，Tauri IPC 通过 `window.__TAURI_INTERNALS__` mock |
| 无障碍扫描（axe） | `npm run test:e2e e2e/tests/a11y.spec.ts` | WCAG 2.1 AA，全 6 路由 |

e2e 套件需要浏览器二进制：

```bash
npx playwright install chromium
npm run test:e2e
```

`e2e/` 目录结构：

- `playwright.config.ts` —— 配置（启动 Vite dev server，无头 chromium）
- `mock-tauri.ts` —— IPC shim，含完整的 `@tauri-apps/plugin-store` 协议 + `plugin:event` + SSE chunk 流式分发器
- `fixtures.ts` / `helpers.ts` —— fixtures + 页面工具函数
- `tests/*.spec.ts` —— 按区域分组的 spec（navigation、dashboard、runs、history、settings、ai-generate、streaming、a11y、theme+locale）

e2e 套件专门跑 Vite dev server（而不是 Tauri binary）—— 这样覆盖 Vue/Pinia/router 端到端流程，而真正的 Rust 行为由 `cargo test` 负责。这把每次 spec 的迭代时间压到 10 秒以内，远快于 WebDriver 的秒级开销。

## 真实 LLM 验证

每个 PR 之前，作者会用 computer-use 在真实 Tauri 桌面上跑端到端检查：

```bash
# 启动 release 包 + 触发 MiniMax-M3 流式生成
open src-tauri/target/release/bundle/macos/PerfPilot.app
# 点击 AI 生成 → 输入场景 → 触发 generate_script_stream
# 实时观察 Monaco 编辑器累积 chunk
```

最近一次（release build）实测：

- 模型：MiniMax-M3（Anthropic 兼容协议，api.minimaxi.com）
- 输入：363 tokens / 输出：440 tokens
- 流式延迟：3.1s 首字节 → 6.2s 完整脚本

## 系统要求

- **macOS** 10.13 或更高（测试环境：macOS 26 Tahoe，arm64）
- **Windows** 10 / 11 x64（NSIS 安装包）
- **Rust** 1.77+（仅开发时需要）
- **Node** 18+ 与 **npm** 9+
- **k6** —— 已随应用打包（sidecar），无需单独安装。运行时优先使用应用内的 k6，其次才是 PATH 上由 Homebrew 等安装的系统版本。如需使用自定义构建，可用 `K6_PATH` 环境变量覆盖

## 发布产物

`.github/workflows/release.yml` 在 push `v*` tag 或手动触发时，构建两套原生安装包：

| 平台 | 产物 | 触发 runner | 备注 |
| --- | --- | --- | --- |
| macOS Apple Silicon | `PerfPilot-0.1.0-arm64.dmg` + `PerfPilot.app` | `macos-latest` | DMG 由 `scripts/build-dmg.sh` 重新打包（绕开 Tauri 内置 DMG bundler 的 v2 已知 bug） |
| Windows x64 | `PerfPilot_0.1.0_x64-setup.exe` | `windows-latest` | NSIS 安装包，通过 `choco install nsis` 提供 makensis |

每个产物单独上传为 GitHub Actions artifact，便于分平台下载。本地手工构建：

```bash
# macOS Apple Silicon
npm run tauri:build -- --target aarch64-apple-darwin
bash scripts/build-dmg.sh

# Windows x64（需要在 Windows runner / 机器上）
npm run tauri:build -- --target x86_64-pc-windows-msvc
```

## 许可

本仓库采用 Apache-2.0 / MIT 双许可。详见 `LICENSE-APACHE-2.0` 与 `LICENSE-MIT`。

## 致谢

- [Tauri](https://tauri.app/) —— Rust + WebView 桌面壳
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) —— VS Code 同款编辑器
- [k6](https://k6.io/) —— Go 写的现代负载测试引擎
- 全部 228 个自动化测试 + 2 轮真机手测都通过的里程碑