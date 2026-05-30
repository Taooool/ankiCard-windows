# AnkiCard 记忆卡片桌面客户端

AnkiCard 是一款基于 **Tauri v2** 构建的极简、轻量级记忆卡片桌面复习客户端。采用炫酷的高保真暗黑科幻视觉风格，通过定时主动弹窗机制，帮助用户在日常使用电脑的过程中，利用碎片化时间强制复习记忆卡片（如英语单词、技术考点等）。

---

## ✨ 核心特性

- **🚀 极速响应**：基于 Rust 后端与 Tauri v2，内存占用极低（通常在 30-50MB 之间），冷启动秒开。
- **⏱️ 智能定时弹窗**：支持自定义时间间隔（分钟/秒级）。倒计时结束后，复习窗口会主动弹出并置顶展示一张待复习卡片。
- **🎯 冷却避重与加权抽取**：
  - **冷却机制**：当卡片数大于 1 时，强制排除上一张刚刚复习过的卡片，绝不允许连续弹出。
  - **加权随机**：熟练度（记忆深度）越低的卡片，被抽中弹出的权重概率越高；当熟练度全满时退化为均匀随机。
- **📥 一键批量导入**：支持解析 `.txt` 或 `.md` 文本文件中的卡片信息并执行一键大批量导入（自动过滤空行及不规则空白，毫秒级递增生成唯一 ID 防止主键碰撞）。
- **🛠️ 批量管理**：提供卡片的多选、全选和批量删除功能，极大简化卡片库维护成本。
- **💾 自动挂起与归档**：
  - **计时器挂起**：当复习弹窗处于打开状态时，主计时器自动冻结挂起，关闭后重置，防止弹窗无限叠加。
  - **休息判定**：若用户直接点击复习窗口右上角的 `X` 强行关闭，系统判定用户希望休息，自动关闭“定时复习”功能。

---

## 🛠️ 技术栈

- **前端**：Vanilla HTML5, CSS3 (高保真磨砂玻璃、霓虹渐变特效), Vanilla JavaScript
- **后端**：Rust (Tauri v2, Tokio 异步运行时, Chrono 时间库, Rand 随机数生成器)
- **数据持久化**：本地 JSON 扁平文件存储（`cards.json` 和 `config.json`），免去繁琐的数据库配置

---

## 📂 项目文档指引

我们为项目准备了完整规范的文档体系，您可以通过以下链接阅读相关文档：

- **📚 架构文档**：[docs/architecture.md](file:///C:/Users/admin/Desktop/project/ankiCard-antigravityCli/docs/architecture.md) ── 模块划分、数据流及技术选型。
- **💻 开发文档**：[docs/development.md](file:///C:/Users/admin/Desktop/project/ankiCard-antigravityCli/docs/development.md) ── 本地开发搭建、编译构建与 Release 打包。
- **🔌 API 文档**：[docs/api.md](file:///C:/Users/admin/Desktop/project/ankiCard-antigravityCli/docs/api.md) ── Tauri Command 接口与全局 Event 广播。
- **🤖 AI 上下文**：[AI_CONTEXT.md](file:///C:/Users/admin/Desktop/project/ankiCard-antigravityCli/AI_CONTEXT.md) ── 当前项目状态、TODO 与 AI 协作衔接指南。
- **🏛️ 架构决策记录 (ADR)**：
  - [ADR-001: 选用 Tauri v2 作为桌面框架](file:///C:/Users/admin/Desktop/project/ankiCard-antigravityCli/docs/adr/001-use-tauri-v2.md)
  - [ADR-002: 选用 JSON 文件作为数据存储层](file:///C:/Users/admin/Desktop/project/ankiCard-antigravityCli/docs/adr/002-data-storage-json.md)
  - [ADR-003: 使用毫秒递增时间戳作为批量导入卡片的唯一 ID](file:///C:/Users/admin/Desktop/project/ankiCard-antigravityCli/docs/adr/003-incremental-timestamp-id.md)

---

## ⚡ 快速开发命令

项目开发与构建的常用命令如下：

```bash
# 1. 安装前端依赖
npm install

# 2. 启动本地开发热重载环境（同时自动启动前端和 Tauri 客户端）
npm run tauri dev

# 3. 运行 Rust 后端单元测试
npm run tauri info # 查看环境状态
cd src-tauri
cargo test

# 4. 构建 Release 发布包 (MSI/NSIS)
npm run tauri build
```

---

## 🎨 界面视觉

应用整体采用暗黑色调搭配极富质感的蓝紫渐变霓虹灯光，按钮采用磨砂半透明（Glassmorphism）高精材质。

- **添加按钮**：亮色霓虹渐变（Indigo-Purple）配合发光阴影动效，指引核心行为。
- **导入/批量按钮**：低调高级的暗色半透明玻璃样式，悬停时外发光。
