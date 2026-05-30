# 系统架构文档 (Architecture)

本文档描述了 AnkiCard 记忆卡片桌面客户端的系统设计、模块划分、数据流动以及物理目录结构。

---

## 1. 架构总览 (High-level Architecture)

AnkiCard 采用典型的 **“前端视图展示 (Web技术) + 后端进程控制 (Rust)”** 的 Tauri 双进程架构：

```text
       ┌─────────────────────────────────────────────────────────┐
       │                 Tauri 主进程 (Rust 后端)                 │
       │                                                         │
       │  ┌───────────────────┐        ┌──────────────────────┐  │
       │  │    AppState       │◄───────┤    DbManager         │  │
       │  │ (内存状态缓存)     │        │ (卡片/配置持久化)     │  │
       │  └─────────┬─────────┘        └──────────────────────┘  │
       │            │                                            │
       │            ▼                                            │
       │  ┌───────────────────┐                                  │
       │  │ 异步轮询与定时器  │───────┐                          │
       │  └───────────────────┘       │                          │
       └────────────┬─────────────────┼──────────────────────────┘
                    │                 │ (动态构建置顶窗口)
     IPC 调用       │                 ▼
     (Tauri Cmd)    │        ┌───────────────────┐
                    │        │  复习窗口         │
                    ▼        │ (reminder 窗口)   │
       ┌───────────────────┐ └─────────┬─────────┘
       │  主窗口           │           │
       │ (main 窗口)       │◄──────────┘ (事件广播: cards-updated /
       └───────────────────┘            config-updated)
```

---

## 2. 模块划分 (Modules)

### 后端模块 (Rust - `src-tauri/src/`)
- **`lib.rs` (核心入口与控制器)**：
  - 定义了核心的数据模型（`Card`, `AppConfig`）。
  - 管理全局互斥状态 `AppState`（包含当前所有卡片的缓存、倒计时数据、是否主动关闭标志、上一次复习卡片的冷却 ID 等）。
  - 启动后台 Tokio 异步定时器线程，每秒轮询一次。若满足提醒条件，则拉起并置顶 `reminder` 窗口。
  - 实现与注册所有暴露给前端的 Tauri Command 接口。
- **`DbManager` (数据存取)**：
  - 封装本地持久化逻辑。
  - 分别读写应用数据目录中的 `cards.json` 和 `config.json`，确保断电或重启后卡片数据与配置不丢失。

### 前端模块 (Frontend - `src/`)
- **`index.html` (视图骨架)**：
  - 定义了主窗口视图（卡片列表、CRUD 模态框、计时控制面板）以及复习窗口视图（翻页复习卡片、记得/不记得按钮组）两套 HTML 骨架。
- **`styles.css` (视觉与动态特效)**：
  - 暗色科幻风格主题。采用高占比的深邃背景色（`#090d16`）、磨砂玻璃效果（`backdrop-filter`）、炫酷的靛蓝与紫色霓虹渐变（`linear-gradient`）和外发光阴影动效。
- **`main.js` (交互逻辑)**：
  - 通过 `handleRoute()` 方法，基于当前窗口的 label 标识进行前端路由和视图分发（`/` 代表主窗口，`#/reminder` 代表复习弹窗窗口）。
  - 管理本地 DOM 交互、表单提交校验、批量选择与批量删除的逻辑。
  - 使用 `FileReader` 解析导入的文本内容，并将解析结果调用后端 Command 批量存入本地。

---

## 3. 数据流设计 (Data Flow)

1. **配置保存数据流**：
   - 前端配置开关或时间发生改变 ──► 调用 `set_timer_config` Command ──► 后端更新 `AppState` 内存数据 ──► 调用 `DbManager` 写入 `config.json` ──► 后端广播 `config-updated` Event ──► 前端各窗口监听到后自动刷新计时器面板。
2. **卡片复习与更新流**：
   - 定时触发或手动拉起复习 ──► `reminder` 窗口弹出卡片 ──► 用户复习并点击反馈 ──► 调用 `review_card` Command ──► 后端重算熟练度深度公式并更新冷却 ID ──► `DbManager` 保存 `cards.json` ──► 广播 `cards-updated` Event ──► 前端主列表监听到广播重新读取并重绘列表。
3. **窗口生命周期控制流**：
   - 后端定时器判定触发 ──► 创建 `reminder` 置顶窗口 ──► 主窗口监听 `timer-triggered` 暂停前端显示 ──► 复习完成，前端调用 `close_reminder_window` ──► 后端标记 `programmatic_close = true` 并关闭该窗口 ──► 触发 `Destroyed` 事件 ──► 后端检测到是正常程序关闭，重置下一次提醒时间。
   - 若用户强行点 `X` 关闭 ──► 触发 `Destroyed` 事件 ──► 后端发现 `programmatic_close` 仍为 `false` ──► 自动将配置中 `is_enabled` 设为 `false`，保护用户免遭打扰。

---

## 4. 目录结构树 (Project Structure)

```text
ankiCard-antigravityCli/
├── .agents/                    # 代理辅助工具与工作流缓存目录
├── docs/                       # 系统架构、开发与接口文档目录
│   ├── adr/                    # 架构决策记录 (ADR)
│   │   ├── 001-use-tauri-v2.md
│   │   ├── 002-data-storage-json.md
│   │   └── 003-incremental-timestamp-id.md
│   ├── architecture.md         # 架构文档 (当前文件)
│   ├── development.md          # 开发文档
│   └── api.md                  # API 接口文档
├── src/                        # 前端 Web 源码
│   ├── index.html              # 主入口 HTML 骨架
│   ├── styles.css              # 霓虹暗黑 CSS 样式
│   └── main.js                 # 核心 JS 路由与交互控制
├── src-tauri/                  # Rust 桌面端后端源码
│   ├── capabilities/           # Tauri 权限与功能配置文件目录
│   ├── permissions/            # 命令权限白名单 (app.toml)
│   ├── src/
│   │   └── lib.rs              # Rust 核心后端、计时器与 Command 实现
│   │   └── main.rs             # Rust 进程引导入口
│   ├── Cargo.toml              # Rust 后端依赖与打包配置文件
│   └── tauri.conf.json         # Tauri 核心窗口与跨平台配置文件
├── AI_CONTEXT.md               # AI 协作断点与当前状态记录
├── README.md                   # 项目自述说明文档
└── package.json                # 前端与 Tauri 脚本配置文件
```
