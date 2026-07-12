<div align="center">

# 😈 Devil Codex

**[한국어](README.md) · [English](README.en.md) · [简体中文](README.zh-CN.md)**

**保留 Codex 的桌面体验，并加入所有模型与真正的电脑控制能力。**

一款面向 macOS / Windows 的桌面应用，以 Codex app-server 为核心，将原生 Codex 模型、外部模型提供商、Bridge、远程控制和 Devil 自有 MCP 工具整合在一起。

[![release](https://img.shields.io/github/v/release/neneee0181/Devil-Codex?color=6c4cf1)](https://github.com/neneee0181/Devil-Codex/releases)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-444)](https://github.com/neneee0181/Devil-Codex)
[![electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![react](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![typescript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

---

<p align="center">
  <img src="assets/screenshots/main-chat.png" alt="Devil Codex 主聊天界面" width="100%" />
  <br />
  <sub>Devil Codex 主聊天 — 在一个界面中处理项目、模型选择、权限与规划</sub>
</p>

---

## ✨ 概览

Devil Codex 以官方 **Codex app-server** 的 thread、turn 和工具体验为基础，加入了以下能力。

- 🧩 **原生与外部模型** — Codex 登录模型尽可能保留原生路径；Claude Code、Copilot、API 和本地模型通过 Devil provider 代理接入同一项目体验。
- 🖥️ **真正的控制** — Devil MCP 工具可以操作内置浏览器和整个操作系统桌面。
- 🌉 **原生 Codex Bridge** — 在原生 Codex 应用/CLI 中仅显示你选择的外部模型。
- 🌐 **远程与语言体验** — 支持基于 Tailscale 的远程访问、强制英文输出、回复翻译和系统通知。

> Devil Codex 是面向 Codex 兼容性的非官方项目，与 OpenAI 没有直接关联。

---

## 🖼️ 界面预览

| 内置浏览器控制 | 侧边聊天 + 终端 |
| --- | --- |
| <img src="assets/screenshots/browser-control.png" alt="Devil MCP 控制内置浏览器" width="100%" /><br /><strong>浏览器控制</strong><br />Devil MCP 可以打开并操作内置浏览器。 | <img src="assets/screenshots/side-chat-terminal.png" alt="同时打开侧边聊天和底部终端" width="100%" /><br /><strong>并行工作空间</strong><br />同时使用侧边聊天和真实的工作区终端。 |

| 文件浏览与预览 | 结构化提问弹窗 |
| --- | --- |
| <img src="assets/screenshots/file-panel.png" alt="在右侧文件标签中预览 README" width="100%" /><br /><strong>文件标签</strong><br />在右侧标签中浏览项目文件并直接预览 Markdown。 | <img src="assets/screenshots/ask-user-modal.png" alt="Devil Ask 用户提问弹窗" width="100%" /><br /><strong>Devil Ask</strong><br />通过结构化提问弹窗收集继续工作所需的选择。 |

<p align="center">
  <img src="assets/screenshots/stock-codex-model-picker.png" alt="原生 Codex 选择器中显示已选择的 Devil Codex Bridge 模型" width="72%" />
  <br />
  <strong>原生 Codex Bridge</strong><br />
  <sub>只有在设置中选择的外部模型会加入原生 Codex 模型选择器；原生 GPT 模型始终优先显示。</sub>
</p>

---

## 🚀 主要功能

### 多模型提供商

在同一个 UI 中切换提供商和模型。Codex 登录模型保持 app-server 直连路径；外部模型使用 Devil 的本地 provider 代理。

| 分类 | 当前路径 |
| --- | --- |
| Codex | 直接通过 app-server 执行，并增强原生模型目录 |
| 登录提供商 | Claude Code · GitHub Copilot · Antigravity |
| API / 托管提供商 | OpenAI-compatible · Anthropic · Google · DeepSeek · xAI · OpenRouter · NVIDIA NIM 等 |
| 本地提供商 | Ollama · vLLM · LM Studio |

- 🔐 API 密钥和 OAuth 凭据使用 Electron `safeStorage` / 操作系统安全存储。
- 🧠 可选择为外部模型启用网页搜索和图像描述 sidecar。
- 🧵 外部提供商对话会被管理，以保持 Devil transcript 和 Codex thread 的连续性。
- ☀️ GPT-5.6 Sol · Terra · Luna 已加入原生 Codex 模型目录，具有权限的账户会使用原生路径请求。

### 原生 Codex 模型选择器联动

关闭 Devil Codex 后，仍可在原生 Codex 应用/CLI 中使用外部模型。

- 在 `设置 → 配置 → Bridge` 中开启或关闭功能。
- 原生 GPT 模型始终优先显示。
- 仅在 `在原生 Codex 中显示的模型` 中添加的外部模型会按设定顺序显示在后面。
- 没有选择数量限制；可使用上下控件更改显示顺序。
- 关闭 Bridge 会从原生 Codex 中移除外部模型，但会保留选择列表，之后重新开启即可恢复。
- 也可以为原生 Codex 中选定的外部模型启用网页搜索和图像描述 sidecar。

> 原生 Codex 选择器使用一个 OpenAI transport。本地 Bridge 负责转换外部模型请求，而原生 Codex 请求会保持原始正文、认证和响应，直接传递至 Codex 后端。

### Devil MCP 工具

这些是模型可调用的 Devil 专用工具；只有在设置中开启的工具才会注册。

- 🌍 **浏览器控制** — 在内置浏览器中导航、点击和输入
- 🖱️ **电脑控制** — 控制整个操作系统桌面的鼠标、键盘和截图
- ❓ **向用户提问** — 结构化多选提问弹窗
- 🧑‍💻 **子代理** — 向外部 provider/model 委派独立任务

子代理不会超过已保存的 Codex 审批策略或沙盒范围，并会明确返回超时、中断和空结果状态。

### 工作流与 UX

- 💬 **请求队列 + 转向** — 工作进行中可排队后续请求，或中断当前工作并优先处理某个请求。
- 🧵 **Thread** — 创建、恢复、搜索、归档，并按 thread 保留右侧/底部工具标签状态。
- 🗂️ **开发环境** — 多项目、Git worktree、变更文件、unified diff、文件/hunk stage/unstage/revert 和行内审查。
- ⌨️ **工具** — 内置终端、Git branch/commit/push，以及打开外部编辑器/终端。
- 🔔 **个性化** — 后台通知、强制英文输出和回复翻译。

### 🌐 远程控制

- 通过 Tailscale Funnel 或直接 Tailnet 地址从手机/浏览器连接。
- 管理令牌和已批准设备。
- 仅显示、读取和发送明确允许远程访问的 thread。

---

## ⚙️ 设置结构

`设置 → 配置` 按用途分为多个标签。

| 标签 | 内容 |
| --- | --- |
| 常规 | 应用信息、审批策略、沙盒、终端、浏览器、语言 |
| 工具 | Devil MCP、向用户提问、子代理、浏览器/电脑控制 |
| 远程 | Tailscale、访问地址、设备、允许的 thread |
| Bridge | 原生 Codex 外部模型选择和 sidecar |
| Sidecar | Devil 应用内外部模型的网页搜索和图像描述辅助功能 |

---

## 🧱 一图了解架构

```text
React renderer  ──IPC──▶  Electron main  ──▶  Codex app-server（原生 Codex 模型）
                                   │
                                   ├─ Devil provider proxy ─▶ 外部 provider API / OAuth / 本地模型
                                   ├─ Devil MCP ────────────▶ 浏览器 / 电脑 / 提问 / 子代理
                                   ├─ Stock Codex Bridge ───▶ 原生 Codex 应用/CLI 的已选模型目录
                                   └─ Remote server ────────▶ 基于 Tailscale 的远程 Web
```

---

## 📦 环境要求

- **Node.js 22+**
- **Codex CLI** 或可用的 Codex 账户
- macOS 或 Windows

> Codex 登录模型使用 Codex 认证。外部模型使用各提供商的 API 密钥、OAuth 或本地 endpoint。

---

## 🛠️ 安装与运行

```bash
# 1) 安装依赖
npm install

# 2) 启动开发模式
npm run dev
```

### 构建 / 打包

```bash
npm run build        # renderer + mobile UI + Electron main
npm run dist:win     # Windows 安装程序
npm run dist:mac     # macOS 应用
```

---

## 🔒 安全说明

- 不要将 API 密钥、OAuth 凭据、远程令牌或其他秘密放入聊天、提交、日志或截图。
- Bridge 和远程控制可能发起真实的外部请求或远程连接；仅在需要时启用。

---

## ⬇️ 下载

从 [**Releases**](https://github.com/neneee0181/Devil-Codex/releases) 获取最新安装程序。推送 `v*` 标签会运行 GitHub Actions 发布工作流。

> 根据代码签名状态，Windows SmartScreen 或 macOS Gatekeeper 可能显示警告。

## 📄 许可证

[MIT](LICENSE) © 2026 neneee0181

<div align="center">
<sub>面向 Codex 兼容性的非官方项目，与 OpenAI 没有直接关联。</sub>
</div>
