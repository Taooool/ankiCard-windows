# 接口与事件文档 (API & Events)

本文档整理了 AnkiCard 桌面客户端中，前端 Web 视图与后端 Rust 主进程之间所有交互的 **Tauri Commands (IPC 调用)** 及 **Tauri Events (全局事件广播)**。

---

## 1. Tauri Commands (前端 invoke 接口)

前端通过调用 `window.__TAURI__.core.invoke(command_name, args)` 与后端交互。所有的 Command 实现都在 [lib.rs](file:///C:/Users/admin/Desktop/project/ankiCard-antigravityCli/src-tauri/src/lib.rs) 中。

### ① `get_cards`
- **说明**：获取当前存储在本地缓存中的全部记忆卡片。
- **调用参数**：无
- **返回值**：`Promise<Array<Card>>`
- **数据结构 `Card`**：
  ```typescript
  interface Card {
    id: string;             // 卡片唯一 ID (创建时的时间戳毫秒字符串)
    front: string;          // 卡片正面问题
    back: string;           // 卡片背面答案
    memory_depth: number;   // 记忆深度熟练度 (0 - 100)
    popup_count: number;    // 累计弹出弹出复习次数
    remember_count: number; // 累计选择“记得”的次数
  }
  ```

### ② `add_card`
- **说明**：向卡片库中添加一张新卡片。
- **调用参数**：
  ```typescript
  { front: string, back: string }
  ```
- **返回值**：`Promise<Card>` (新创建的卡片对象)

### ③ `edit_card`
- **说明**：编辑现有卡片内容。
- **调用参数**：
  ```typescript
  { id: string, front: string, back: string }
  ```
- **返回值**：`Promise<Card>` (更新后的卡片对象)

### ④ `delete_card`
- **说明**：删除单张卡片。
- **调用参数**：
  ```typescript
  { id: string }
  ```
- **返回值**：`Promise<void>`

### ⑤ `delete_cards`
- **说明**：批量删除多张卡片（需要在 `permissions/app.toml` 中显式授权）。
- **调用参数**：
  ```typescript
  { ids: Array<string> }
  ```
- **返回值**：`Promise<void>`

### ⑥ `import_cards`
- **说明**：一键批量导入多张卡片（需要在 `permissions/app.toml` 中显式授权）。
- **调用参数**：
  ```typescript
  { newCards: Array<[string, string]> } // 正反面二元组列表
  ```
- **返回值**：`Promise<number>` (成功导入的卡片数量)

### ⑦ `review_card`
- **说明**：提交卡片的复习判定结果，后端将重新计算熟练度并写入持久化文件。
- **调用参数**：
  ```typescript
  { id: string, remembered: boolean }
  ```
- **返回值**：`Promise<Card>` (计算熟练度更新后的卡片对象)

### ⑧ `get_reminder_card`
- **说明**：由复习窗口 `reminder` 调用，后端将通过加权随机算法筛选并返回当前最合适复习的一张卡片。
- **调用参数**：无
- **返回值**：`Promise<Card | null>`

### ⑨ `get_timer_config`
- **说明**：读取当前应用的定时提醒器配置。
- **调用参数**：无
- **返回值**：`Promise<AppConfig>`
- **数据结构 `AppConfig`**：
  ```typescript
  interface AppConfig {
    interval_secs: number;  // 提醒时间间隔（秒）
    is_enabled: boolean;    // 是否开启自动定时弹窗
  }
  ```

### ⑩ `set_timer_config`
- **说明**：更改提醒时间及启用状态。
- **调用参数**：
  ```typescript
  { intervalSecs: number, isEnabled: boolean }
  ```
- **返回值**：`Promise<AppConfig>` (保存更新后的配置对象)

### ⑪ `close_reminder_window`
- **说明**：前端告知后端可以正常销毁复习提醒窗口，以规避“强退判定惩罚”逻辑。
- **调用参数**：无
- **返回值**：`Promise<void>`

---

## 2. Tauri Events (全局事件广播)

应用通过 `window.__TAURI__.event.listen(event_name, callback)` 监听跨窗口事件，用于维持多窗口间的数据状态同步。

### ① `cards-updated`
- **说明**：卡片库发生更改（新增、修改、删除、导入）时，后端向所有窗口发送此广播，通知前端重载卡片列表。
- **事件载荷**：无

### ② `config-updated`
- **说明**：定时器提醒配置（提醒间隔或开关）被修改，或者在后台线程由于强退惩罚强行关闭开关时广播。
- **事件载荷**：
  ```typescript
  AppConfig
  ```

### ③ `timer-triggered`
- **说明**：后台定时器检测到复习时间已到，正在尝试拉起 `reminder` 窗口。主窗口收到该事件后，会将倒计时面板的状态文字更新为 `复习进行中...`。
- **事件载荷**：无

### ④ `reload-card`
- **说明**：复习窗口弹出时，若由于生命周期限制已有一个窗口未销毁，则后端复用该窗口并广播 `reload-card` 事件，通知前端重载新卡片。
- **事件载荷**：无
