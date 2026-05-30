# 项目开发文档 (Development)

本文档旨在引导开发人员快速搭建本地开发环境、执行日常调试开发、运行单元测试，以及编译打包 Release 发布版客户端。

---

## 1. 前置环境搭建 (Prerequisites)

在开始本地开发之前，您的机器上需要安装并配置好以下基础开发依赖环境：

1. **Node.js** (推荐 `v18.x` 或以上版本)
   - 提供前端环境运行与 Tauri CLI 的管理。
2. **Rust 编译工具链** (包含 `cargo` 软件包管理器，推荐最新的 Stable 版本)
   - 官方安装渠道：[Rustup](https://rustup.rs/)。
3. **C++ 构建工具 / Windows SDK** (Windows 平台适用)
   - Windows 环境下通常需要通过 Visual Studio Installer 安装 "使用 C++ 的桌面开发" 工作负载，确保 Rust 编译器能够顺利调用系统链接器。

---

## 2. 本地开发与调试 (Local Development)

### 依赖安装
首先，拉取项目代码后，在项目根目录下安装所需的 Node 开发依赖：
```bash
npm install
```

### 启动热重载开发服务器
通过 Tauri CLI 一键启动开发环境。它将自动编译 Rust 后端代码、启动前端 dev 监听，并在编译成功后弹出测试客户端窗口：
```bash
npm run tauri dev
```
> **提示**：前端代码位于 `src/` 目录下，对 HTML/CSS/JS 的修改保存后，应用视图会自动热重载（HMR）；若修改了 `src-tauri/src/` 中的 Rust 后端代码，Tauri 会自动捕获变更并重新执行后台增量编译与程序重启。

---

## 3. 测试与验证 (Testing & Linting)

为了确保合并和发布版本的质量，在提交或打包前，建议在本地执行测试和静态检查：

### 运行单元测试
在 `src-tauri` 目录下运行 Rust 单元测试（主要是数据模型公式与卡片优先级随机抽取排序的算法测试）：
```bash
cd src-tauri
cargo test
```

### 运行静态检查
对 Rust 代码进行快速的静态编译类型检查，规避潜在的所有权冲突或未定义引用：
```bash
cd src-tauri
cargo check
```

---

## 4. Release 打包与构建流程 (Release Build)

当需要生成正式分发的生产安装包时，在项目根目录下执行以下命令：

```bash
npm run tauri build
```

编译完成后，Tauri 将在 `src-tauri/target/release/bundle/` 下自动生成打包好的桌面端文件。对于 Windows 平台：

1. **MSI 安装包**：
   - 路径：`src-tauri/target/release/bundle/msi/tauri-app_0.2.0_x64_en-US.msi`
   - 特点：适合静默安装、企业策略分发。
2. **NSIS 安装包**：
   - 路径：`src-tauri/target/release/bundle/nsis/tauri-app_0.2.0_x64-setup.exe`
   - 特点：用户友好的极简一步安装程序。

---

## 5. 打包版本管理约束

- 本项目严格遵循 **语义化版本 (Semantic Versioning)** 规范。
- 当需要提升版本号时，需要同时修改以下四个文件中的版本声明，保证版本一致性：
  1. `package.json` 中的 `"version"`
  2. `src-tauri/Cargo.toml` 中的 `version`
  3. `src-tauri/tauri.conf.json` 中的 `"version"`
  4. `src/index.html` 中的页面版本标示（如 `<span class="badge-version">v0.2.0</span>`）
