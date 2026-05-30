use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::fs;
use std::path::PathBuf;
use tauri::{State, Manager, AppHandle, Emitter, WebviewWindowBuilder, WebviewUrl};
use chrono::Local;
use tokio::time::{sleep, Duration};

/// 反序列化辅助函数：配置文件的默认启用状态
fn default_true() -> bool {
    true
}

/// 反序列化辅助函数：配置文件定时提醒的默认秒数（10分钟）
fn default_interval_secs() -> u32 {
    600 // 10 minutes * 60 seconds
}

/// 记忆卡片实体结构体
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Card {
    /// 唯一标识符，采用创建时间戳
    pub id: String,
    /// 卡片正面内容（问题、词汇等）
    pub front: String,
    /// 卡片背面内容（答案、释义等）
    pub back: String,
    /// 记忆熟练度/深度（0-100 百分比）
    #[serde(default)]
    pub memory_depth: u32,
    /// 卡片累计弹出次数
    #[serde(default)]
    pub popup_count: u32,
    /// 用户选择“记得”的累计次数
    #[serde(default)]
    pub remember_count: u32,
}

/// 应用定时器与功能配置结构体
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppConfig {
    /// 定时复习提醒时间间隔（秒）
    #[serde(default = "default_interval_secs")]
    pub interval_secs: u32,
    /// 自动定时复习是否启用开关
    #[serde(default = "default_true")]
    pub is_enabled: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            interval_secs: 600,
            is_enabled: true,
        }
    }
}

/// 本地文件数据库管理器，负责存取卡片和配置
pub struct DbManager {
    /// 本地 AppData 目录存储路径
    data_dir: PathBuf,
}

impl DbManager {
    /// 构造一个新的 DbManager，确保本地应用数据目录存在
    pub fn new(app_handle: &AppHandle) -> Self {
        let data_dir = app_handle.path().app_data_dir().unwrap_or_else(|_| {
            PathBuf::from(".")
        });
        
        if !data_dir.exists() {
            let _ = fs::create_dir_all(&data_dir);
        }
        
        Self { data_dir }
    }
    
    /// 获取卡片实体 JSON 存储路径
    pub fn get_cards_path(&self) -> PathBuf {
        self.data_dir.join("cards.json")
    }
    
    /// 获取配置文件 JSON 存储路径
    pub fn get_config_path(&self) -> PathBuf {
        self.data_dir.join("config.json")
    }
    
    /// 从本地加载卡片列表，若不存在或损坏则返回空 Vector
    pub fn load_cards(&self) -> Vec<Card> {
        let path = self.get_cards_path();
        if path.exists() {
            if let Ok(content) = fs::read_to_string(path) {
                if let Ok(cards) = serde_json::from_str::<Vec<Card>>(&content) {
                    return cards;
                }
            }
        }
        Vec::new()
    }
    
    /// 将卡片列表以漂亮格式（Pretty-printed）保存到本地 cards.json
    pub fn save_cards(&self, cards: &[Card]) -> Result<(), String> {
        let path = self.get_cards_path();
        let content = serde_json::to_string_pretty(cards)
            .map_err(|e| e.to_string())?;
        fs::write(path, content).map_err(|e| e.to_string())?;
        Ok(())
    }
    
    /// 从本地加载应用配置，若不存在则返回默认配置
    pub fn load_config(&self) -> AppConfig {
        let path = self.get_config_path();
        if path.exists() {
            if let Ok(content) = fs::read_to_string(path) {
                if let Ok(config) = serde_json::from_str::<AppConfig>(&content) {
                    return config;
                }
            }
        }
        AppConfig::default()
    }
    
    /// 将应用配置以漂亮格式保存到本地 config.json
    pub fn save_config(&self, config: &AppConfig) -> Result<(), String> {
        let path = self.get_config_path();
        let content = serde_json::to_string_pretty(config)
            .map_err(|e| e.to_string())?;
        fs::write(path, content).map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// 存储在 Mutex 锁保护中的全局可变应用状态
pub struct AppStateInner {
    /// 内存缓存中的所有卡片实体列表
    pub cards: Vec<Card>,
    /// 当前应用运行配置
    pub config: AppConfig,
    /// 下一次定时弹窗触发的毫秒时间戳（0 表示正在弹窗中挂起）
    pub next_trigger_time: i64,
    /// 数据文件管理器实例
    pub db: DbManager,
    /// 是否为程序主动触发的窗口关闭行为（用于判断用户点击 X 强退）
    pub programmatic_close: bool,
    /// 上一次刚刚复习过的卡片 ID（用于冷却机制防止连续重复弹出）
    pub last_reviewed_id: Option<String>,
}

/// Tauri 全局应用共享状态包装器
pub struct AppState {
    pub inner: Mutex<AppStateInner>,
}

/// 触发并弹出复习窗口逻辑
///
/// 若窗口已存在，则显示并置顶、发送 reload 广播；
/// 若窗口不存在，则动态构建带有深色底色并默认可见的复习窗体，消灭 WebView 初始化闪烁。
fn trigger_popup(app: &AppHandle) -> Result<(), String> {
    if let Some(reminder) = app.get_webview_window("reminder") {
        let _ = reminder.show();
        let _ = reminder.center();
        let _ = reminder.set_always_on_top(true);
        let _ = reminder.set_focus();
        let _ = reminder.emit("reload-card", ());
    } else {
        let builder = WebviewWindowBuilder::new(
            app,
            "reminder",
            WebviewUrl::App("index.html".into())
        )
        .title("复习")
        .inner_size(460.0, 320.0)
        .center()
        .always_on_top(true)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .decorations(true);
        
        let window = builder.build().map_err(|e| e.to_string())?;
        // 设置窗口原生底色，避免第一帧闪白屏
        let _ = window.set_background_color(Some(tauri::window::Color(9, 13, 22, 255)));
    }
    
    // 通知主窗口更新计时器相关的视图挂起状态
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("timer-triggered", ());
    }
    
    Ok(())
}

/// 获取当前所有卡片数据列表
#[tauri::command]
fn get_cards(state: State<'_, AppState>) -> Vec<Card> {
    let inner = state.inner.lock().unwrap();
    inner.cards.clone()
}

/// 添加单张新卡片
///
/// * `front` - 卡片正面问题
/// * `back` - 卡片背面答案
#[tauri::command]
fn add_card(state: State<'_, AppState>, app: AppHandle, front: String, back: String) -> Result<Card, String> {
    let mut inner = state.inner.lock().unwrap();
    let now = Local::now().timestamp_millis();
    let card = Card {
        id: now.to_string(),
        front,
        back,
        memory_depth: 0,
        popup_count: 0,
        remember_count: 0,
    };
    inner.cards.push(card.clone());
    inner.db.save_cards(&inner.cards)?;
    
    // 通知主窗口重新加载最新列表
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("cards-updated", ());
    }
    
    Ok(card)
}

/// 编辑现有卡片内容
///
/// * `id` - 卡片唯一标识戳
/// * `front` - 新的卡片正面问题
/// * `back` - 新的卡片背面答案
#[tauri::command]
fn edit_card(state: State<'_, AppState>, app: AppHandle, id: String, front: String, back: String) -> Result<Card, String> {
    let mut inner = state.inner.lock().unwrap();
    if let Some(card) = inner.cards.iter_mut().find(|c| c.id == id) {
        card.front = front;
        card.back = back;
        let cloned = card.clone();
        inner.db.save_cards(&inner.cards)?;
        
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.emit("cards-updated", ());
        }
        
        Ok(cloned)
    } else {
        Err("Card not found".into())
    }
}

/// 删除单张卡片
///
/// * `id` - 待删除卡片 ID
#[tauri::command]
fn delete_card(state: State<'_, AppState>, app: AppHandle, id: String) -> Result<(), String> {
    let mut inner = state.inner.lock().unwrap();
    let len_before = inner.cards.len();
    inner.cards.retain(|c| c.id != id);
    
    if inner.cards.len() < len_before {
        inner.db.save_cards(&inner.cards)?;
        
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.emit("cards-updated", ());
        }
        
        Ok(())
    } else {
        Err("Card not found".into())
    }
}

/// 批量删除多张卡片
///
/// * `ids` - 待删除卡片的 ID 列表
#[tauri::command]
fn delete_cards(state: State<'_, AppState>, app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let mut inner = state.inner.lock().unwrap();
    let len_before = inner.cards.len();
    inner.cards.retain(|c| !ids.contains(&c.id));
    
    // 若冷却中的卡片被一并删除，则清空冷却 ID，规避指针悬挂或逻辑错乱
    if let Some(ref last_id) = inner.last_reviewed_id {
        if ids.contains(last_id) {
            inner.last_reviewed_id = None;
        }
    }
    
    if inner.cards.len() < len_before {
        inner.db.save_cards(&inner.cards)?;
        
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.emit("cards-updated", ());
        }
        
        Ok(())
    } else {
        Err("No cards found to delete".into())
    }
}

/// 一键批量导入多张卡片
///
/// * `new_cards` - 前端解析得到的卡片正面、背面二元组 Vector 列表
#[tauri::command]
fn import_cards(
    state: State<'_, AppState>,
    app: AppHandle,
    new_cards: Vec<(String, String)>,
) -> Result<usize, String> {
    if new_cards.is_empty() {
        return Ok(0);
    }
    
    let mut inner = state.inner.lock().unwrap();
    let mut now = Local::now().timestamp_millis();
    let mut count = 0;
    
    for (front, back) in new_cards {
        // 在批量创建时，每次累加 1ms 生成唯一 ID，绝对规避卡片 ID 碰撞
        let card = Card {
            id: now.to_string(),
            front,
            back,
            memory_depth: 0,
            popup_count: 0,
            remember_count: 0,
        };
        inner.cards.push(card);
        now += 1;
        count += 1;
    }
    
    inner.db.save_cards(&inner.cards)?;
    
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("cards-updated", ());
    }
    
    Ok(count)
}

/// 提交卡片复习结果，重新计算卡片记忆熟练度
///
/// * `id` - 卡片 ID
/// * `remembered` - 是否记得（记得/不记得）
#[tauri::command]
fn review_card(state: State<'_, AppState>, app: AppHandle, id: String, remembered: bool) -> Result<Card, String> {
    let mut inner = state.inner.lock().unwrap();
    inner.last_reviewed_id = Some(id.clone());
    
    let cloned_card = if let Some(card) = inner.cards.iter_mut().find(|c| c.id == id) {
        card.popup_count += 1;
        if remembered {
            card.remember_count += 1;
        }
        // 熟练度记忆深度公式计算
        card.memory_depth = (card.remember_count * 100) / card.popup_count;
        card.clone()
    } else {
        return Err("Card not found".into());
    };
    
    inner.db.save_cards(&inner.cards)?;
    
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("cards-updated", ());
    }
    
    Ok(cloned_card)
}

/// 根据加权随机与排除冷却逻辑，获取待复习的目标卡片
///
/// 算法设计：
/// 1. 冷却机制：当总卡片数大于 1 张时，强制排除上一张刚刚复习过的卡片，绝不允许连续弹出。
/// 2. 权重计算：未冷却候选卡片权重为 `101 - memory_depth`（熟练度越低，被抽中的概率越大）。
/// 3. 退化设计：若所有卡片熟练度均达到 100%，所有卡片权重为 1，退化为均匀随机抽取。
#[tauri::command]
fn get_reminder_card(state: State<'_, AppState>) -> Option<Card> {
    let inner = state.inner.lock().unwrap();
    
    if inner.cards.is_empty() {
        return None;
    }
    
    // 冷却处理
    let available_cards: Vec<&Card> = if inner.cards.len() > 1 {
        if let Some(ref last_id) = inner.last_reviewed_id {
            inner.cards.iter().filter(|c| c.id != *last_id).collect()
        } else {
            inner.cards.iter().collect()
        }
    } else {
        inner.cards.iter().collect()
    };
    
    // 权重计算与加权随机抽取
    let total_weight: u32 = available_cards.iter().map(|c| 101 - c.memory_depth).sum();
    let mut random_val = rand::random_range(0..total_weight);
    
    for card in &available_cards {
        let weight = 101 - card.memory_depth;
        if random_val < weight {
            return Some((*card).clone());
        }
        random_val -= weight;
    }
    
    available_cards.last().map(|c| (*c).clone())
}

/// 获取当前提醒间隔与开关配置数据
#[tauri::command]
fn get_timer_config(state: State<'_, AppState>) -> AppConfig {
    let inner = state.inner.lock().unwrap();
    inner.config.clone()
}

/// 获取下一次定时弹窗的倒计时时间戳
#[tauri::command]
fn get_next_trigger_time(state: State<'_, AppState>) -> i64 {
    let inner = state.inner.lock().unwrap();
    inner.next_trigger_time
}

/// 设定定时提醒参数，写入文件并重置下一次倒计时点
///
/// * `interval_secs` - 定时时间间隔（秒）
/// * `is_enabled` - 是否开启定时提醒
#[tauri::command]
fn set_timer_config(
    state: State<'_, AppState>,
    app: AppHandle,
    interval_secs: u32,
    is_enabled: bool,
) -> Result<AppConfig, String> {
    let mut inner = state.inner.lock().unwrap();
    inner.config.interval_secs = interval_secs;
    inner.config.is_enabled = is_enabled;
    
    let now = Local::now().timestamp_millis();
    inner.next_trigger_time = now + (interval_secs as i64) * 1000;
    
    inner.db.save_config(&inner.config)?;
    
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("config-updated", inner.config.clone());
    }
    
    Ok(inner.config.clone())
}

/// 前端获取当前所在窗口标签标识
#[tauri::command]
async fn get_window_label(window: tauri::Window) -> String {
    window.label().to_string()
}

/// 由程序代码触发主动关闭复习窗口，重置 programmatic_close 标志以防止触发强退惩罚
#[tauri::command]
async fn close_reminder_window(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    {
        let mut inner = state.inner.lock().unwrap();
        inner.programmatic_close = true;
    }
    if let Some(reminder) = app.get_webview_window("reminder") {
        let _ = reminder.close();
    }
    Ok(())
}

/// Tauri 2.0 应用主程序生命周期与后台线程逻辑入口
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            
            // 实例化本地数据加载
            let db = DbManager::new(&app_handle);
            let cards = db.load_cards();
            let config = db.load_config();
            
            let now = Local::now().timestamp_millis();
            let next_trigger_time = now + (config.interval_secs as i64) * 1000;
            
            app.manage(AppState {
                inner: Mutex::new(AppStateInner {
                    cards,
                    config,
                    next_trigger_time,
                    db,
                    programmatic_close: false,
                    last_reviewed_id: None,
                }),
            });
            
            // 启动异步线程：每 1 秒轮询检查下一次弹窗唤醒时间点
            tauri::async_runtime::spawn(async move {
                loop {
                    sleep(Duration::from_secs(1)).await;
                    
                    let mut trigger_needed = false;
                    let state = app_handle.state::<AppState>();
                    {
                        let mut inner = state.inner.lock().unwrap();
                        let now = Local::now().timestamp_millis();
                        
                        // 挂起判定：当复习提醒窗口当前处于打开状态时，挂起冻结计时器置为 0
                        let has_reminder_window = app_handle.get_webview_window("reminder").is_some();
                        if has_reminder_window {
                            if inner.next_trigger_time != 0 {
                                inner.next_trigger_time = 0;
                                if let Some(main) = app_handle.get_webview_window("main") {
                                    let _ = main.emit("config-updated", inner.config.clone());
                                }
                            }
                        } else {
                            // 唤醒重置：若之前计时器因为窗口打开而被挂起冻结，窗口关闭时重置下一次提醒计时器
                            if inner.next_trigger_time == 0 {
                                inner.next_trigger_time = now + (inner.config.interval_secs as i64) * 1000;
                                if let Some(main) = app_handle.get_webview_window("main") {
                                    let _ = main.emit("config-updated", inner.config.clone());
                                }
                            }
                            
                            // 计时点到达：执行窗口弹出触发并重设时间
                            if inner.config.is_enabled && now >= inner.next_trigger_time {
                                trigger_needed = true;
                                inner.next_trigger_time = now + (inner.config.interval_secs as i64) * 1000;
                                
                                if let Some(main) = app_handle.get_webview_window("main") {
                                    let _ = main.emit("config-updated", inner.config.clone());
                                }
                            }
                        }
                    }
                    
                    if trigger_needed {
                        let _ = trigger_popup(&app_handle);
                    }
                }
            });
            
            Ok(())
        })
        .on_window_event(|window, event| {
            // 监听复习弹窗销毁行为
            if window.label() == "reminder" {
                if let tauri::WindowEvent::Destroyed = event {
                    let state = window.state::<AppState>();
                    let mut inner = state.inner.lock().unwrap();
                    if inner.programmatic_close {
                        // 正常途径关闭（已提交复习），重置主动关闭标志
                        inner.programmatic_close = false;
                    } else {
                        // 用户点击右上角 X 手动关闭 -> 判定用户想休息，自动禁用“定时复习”开关，并保存同步
                        inner.config.is_enabled = false;
                        let _ = inner.db.save_config(&inner.config);
                        if let Some(main) = window.app_handle().get_webview_window("main") {
                            let _ = main.emit("config-updated", inner.config.clone());
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_cards,
            add_card,
            edit_card,
            delete_card,
            delete_cards,
            import_cards,
            review_card,
            get_reminder_card,
            get_timer_config,
            set_timer_config,
            get_next_trigger_time,
            get_window_label,
            close_reminder_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_card_review_remembered() {
        let mut card = Card {
            id: "1".into(),
            front: "Q".into(),
            back: "A".into(),
            memory_depth: 0,
            popup_count: 0,
            remember_count: 0,
        };

        card.popup_count += 1;
        card.remember_count += 1;
        card.memory_depth = (card.remember_count * 100) / card.popup_count;

        assert_eq!(card.memory_depth, 100);
        assert_eq!(card.popup_count, 1);
        assert_eq!(card.remember_count, 1);

        card.popup_count += 1;
        card.memory_depth = (card.remember_count * 100) / card.popup_count;

        assert_eq!(card.memory_depth, 50);
        assert_eq!(card.popup_count, 2);
        assert_eq!(card.remember_count, 1);
    }

    #[test]
    fn test_due_cards_priority_sorting() {
        let card1 = Card {
            id: "2".into(),
            front: "Q1".into(),
            back: "A1".into(),
            memory_depth: 50,
            popup_count: 2,
            remember_count: 1,
        };
        
        let card2 = Card {
            id: "1".into(),
            front: "Q2".into(),
            back: "A2".into(),
            memory_depth: 0,
            popup_count: 0,
            remember_count: 0,
        };

        let card3 = Card {
            id: "3".into(),
            front: "Q3".into(),
            back: "A3".into(),
            memory_depth: 50,
            popup_count: 2,
            remember_count: 1,
        };

        let mut cards = vec![card1, card2, card3];

        cards.sort_by(|a, b| {
            a.memory_depth.cmp(&b.memory_depth)
                .then(a.id.cmp(&b.id))
        });

        assert_eq!(cards[0].id, "1");
        assert_eq!(cards[1].id, "2");
        assert_eq!(cards[2].id, "3");
    }
}
