use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::fs;
use std::path::PathBuf;
use tauri::{State, Manager, AppHandle, Emitter, WebviewWindowBuilder, WebviewUrl};
use chrono::{Local};
use tokio::time::{sleep, Duration};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Card {
    pub id: String,
    pub front: String,
    pub back: String,
    pub create_time: i64,          // timestamp in ms
    pub memory_depth: u32,
    pub interval_mins: u32,
    pub next_review_time: i64,     // timestamp in ms
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppConfig {
    pub interval_mins: u32,       // Timer interval
    pub is_enabled: bool,         // Is timer enabled
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            interval_mins: 10,
            is_enabled: true,
        }
    }
}

pub struct DbManager {
    data_dir: PathBuf,
}

impl DbManager {
    pub fn new(app_handle: &AppHandle) -> Self {
        let data_dir = app_handle.path().app_data_dir().unwrap_or_else(|_| {
            PathBuf::from(".")
        });
        
        if !data_dir.exists() {
            let _ = fs::create_dir_all(&data_dir);
        }
        
        Self { data_dir }
    }
    
    pub fn get_cards_path(&self) -> PathBuf {
        self.data_dir.join("cards.json")
    }
    
    pub fn get_config_path(&self) -> PathBuf {
        self.data_dir.join("config.json")
    }
    
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
    
    pub fn save_cards(&self, cards: &[Card]) -> Result<(), String> {
        let path = self.get_cards_path();
        let content = serde_json::to_string_pretty(cards)
            .map_err(|e| e.to_string())?;
        fs::write(path, content).map_err(|e| e.to_string())?;
        Ok(())
    }
    
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
    
    pub fn save_config(&self, config: &AppConfig) -> Result<(), String> {
        let path = self.get_config_path();
        let content = serde_json::to_string_pretty(config)
            .map_err(|e| e.to_string())?;
        fs::write(path, content).map_err(|e| e.to_string())?;
        Ok(())
    }
}

pub struct AppStateInner {
    pub cards: Vec<Card>,
    pub config: AppConfig,
    pub next_trigger_time: i64,
    pub db: DbManager,
}

pub struct AppState {
    pub inner: Mutex<AppStateInner>,
}

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
        .title("记忆卡片提醒")
        .inner_size(460.0, 320.0)
        .center()
        .always_on_top(true)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .decorations(true);
        
        let _window = builder.build().map_err(|e| e.to_string())?;
    }
    
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("timer-triggered", ());
    }
    
    Ok(())
}

#[tauri::command]
fn get_cards(state: State<'_, AppState>) -> Vec<Card> {
    let inner = state.inner.lock().unwrap();
    inner.cards.clone()
}

#[tauri::command]
fn add_card(state: State<'_, AppState>, app: AppHandle, front: String, back: String) -> Result<Card, String> {
    let mut inner = state.inner.lock().unwrap();
    let now = Local::now().timestamp_millis();
    let card = Card {
        id: now.to_string(),
        front,
        back,
        create_time: now,
        memory_depth: 0,
        interval_mins: 0,
        next_review_time: now, // Due immediately
    };
    inner.cards.push(card.clone());
    inner.db.save_cards(&inner.cards)?;
    
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("cards-updated", ());
    }
    
    Ok(card)
}

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

#[tauri::command]
fn review_card(state: State<'_, AppState>, app: AppHandle, id: String, remembered: bool) -> Result<Card, String> {
    let mut inner = state.inner.lock().unwrap();
    if let Some(card) = inner.cards.iter_mut().find(|c| c.id == id) {
        let now = Local::now().timestamp_millis();
        
        if remembered {
            card.memory_depth += 1;
            card.interval_mins = match card.memory_depth {
                1 => 5,          // 5 mins
                2 => 30,         // 30 mins
                3 => 720,        // 12 hours (720 mins)
                4 => 1440,       // 1 day
                5 => 2880,       // 2 days
                6 => 5760,       // 4 days
                7 => 10080,      // 7 days
                8 => 21600,      // 15 days
                _ => card.interval_mins * 2, // Double interval
            };
            card.next_review_time = now + (card.interval_mins as i64) * 60 * 1000;
        } else {
            card.memory_depth = 0;
            card.interval_mins = 1; // 1 min
            card.next_review_time = now + 1 * 60 * 1000;
        }
        
        let cloned = card.clone();
        inner.db.save_cards(&inner.cards)?;
        
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.emit("cards-updated", ());
        }
        if let Some(reminder) = app.get_webview_window("reminder") {
            let _ = reminder.emit("cards-updated", ());
        }
        
        Ok(cloned)
    } else {
        Err("Card not found".into())
    }
}

#[tauri::command]
fn get_reminder_card(state: State<'_, AppState>) -> Option<Card> {
    let inner = state.inner.lock().unwrap();
    let now = Local::now().timestamp_millis();
    
    let mut due_cards: Vec<Card> = inner.cards.iter()
        .filter(|c| c.next_review_time <= now)
        .cloned()
        .collect();
    
    if due_cards.is_empty() {
        None
    } else {
        // Sort due cards:
        // 1. memory_depth ASC (prioritize lower memory depths)
        // 2. next_review_time ASC (most overdue first)
        due_cards.sort_by(|a, b| {
            a.memory_depth.cmp(&b.memory_depth)
                .then(a.next_review_time.cmp(&b.next_review_time))
        });
        
        Some(due_cards[0].clone())
    }
}

#[tauri::command]
fn get_random_card(state: State<'_, AppState>) -> Option<Card> {
    let inner = state.inner.lock().unwrap();
    if inner.cards.is_empty() {
        None
    } else {
        // Prioritize lower memory depth, then sort by create time
        let mut cards = inner.cards.clone();
        cards.sort_by(|a, b| {
            a.memory_depth.cmp(&b.memory_depth)
                .then(a.create_time.cmp(&b.create_time))
        });
        Some(cards[0].clone())
    }
}

#[tauri::command]
fn get_timer_config(state: State<'_, AppState>) -> AppConfig {
    let inner = state.inner.lock().unwrap();
    inner.config.clone()
}

#[tauri::command]
fn get_next_trigger_time(state: State<'_, AppState>) -> i64 {
    let inner = state.inner.lock().unwrap();
    inner.next_trigger_time
}

#[tauri::command]
fn set_timer_config(
    state: State<'_, AppState>,
    app: AppHandle,
    interval_mins: u32,
    is_enabled: bool,
) -> Result<AppConfig, String> {
    let mut inner = state.inner.lock().unwrap();
    inner.config.interval_mins = interval_mins;
    inner.config.is_enabled = is_enabled;
    
    let now = Local::now().timestamp_millis();
    inner.next_trigger_time = now + (interval_mins as i64) * 60 * 1000;
    
    inner.db.save_config(&inner.config)?;
    
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("config-updated", inner.config.clone());
    }
    
    Ok(inner.config.clone())
}

#[tauri::command]
async fn trigger_reminder_manually(app: AppHandle) -> Result<(), String> {
    trigger_popup(&app)
}

#[tauri::command]
async fn get_window_label(window: tauri::Window) -> String {
    window.label().to_string()
}

#[tauri::command]
async fn close_reminder_window(app: AppHandle) -> Result<(), String> {
    if let Some(reminder) = app.get_webview_window("reminder") {
        let _ = reminder.close();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            
            let db = DbManager::new(&app_handle);
            let cards = db.load_cards();
            let config = db.load_config();
            
            let now = Local::now().timestamp_millis();
            let next_trigger_time = now + (config.interval_mins as i64) * 60 * 1000;
            
            app.manage(AppState {
                inner: Mutex::new(AppStateInner {
                    cards,
                    config,
                    next_trigger_time,
                    db,
                }),
            });
            
            tauri::async_runtime::spawn(async move {
                loop {
                    sleep(Duration::from_secs(1)).await;
                    
                    let mut trigger_needed = false;
                    
                    let state = app_handle.state::<AppState>();
                    {
                        let mut inner = state.inner.lock().unwrap();
                        if inner.config.is_enabled {
                            let now = Local::now().timestamp_millis();
                            if now >= inner.next_trigger_time {
                                trigger_needed = true;
                                inner.next_trigger_time = now + (inner.config.interval_mins as i64) * 60 * 1000;
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
        .invoke_handler(tauri::generate_handler![
            get_cards,
            add_card,
            edit_card,
            delete_card,
            review_card,
            get_reminder_card,
            get_random_card,
            get_timer_config,
            set_timer_config,
            get_next_trigger_time,
            trigger_reminder_manually,
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
            create_time: 1000,
            memory_depth: 0,
            interval_mins: 0,
            next_review_time: 1000,
        };

        // Review 1: Remembered (depth -> 1)
        let now = 2000;
        card.memory_depth += 1;
        card.interval_mins = match card.memory_depth {
            1 => 5,
            _ => 0,
        };
        card.next_review_time = now + (card.interval_mins as i64) * 60 * 1000;

        assert_eq!(card.memory_depth, 1);
        assert_eq!(card.interval_mins, 5);
        assert_eq!(card.next_review_time, 2000 + 5 * 60 * 1000);

        // Review 2: Remembered (depth -> 2)
        card.memory_depth += 1;
        card.interval_mins = match card.memory_depth {
            1 => 5,
            2 => 30,
            _ => 0,
        };
        card.next_review_time = now + (card.interval_mins as i64) * 60 * 1000;

        assert_eq!(card.memory_depth, 2);
        assert_eq!(card.interval_mins, 30);
        assert_eq!(card.next_review_time, 2000 + 30 * 60 * 1000);
    }

    #[test]
    fn test_card_review_forgotten() {
        let mut card = Card {
            id: "1".into(),
            front: "Q".into(),
            back: "A".into(),
            create_time: 1000,
            memory_depth: 3,
            interval_mins: 720,
            next_review_time: 1000,
        };

        // Review: Forgotten (depth -> 0, interval -> 1 min)
        let now = 2000;
        card.memory_depth = 0;
        card.interval_mins = 1;
        card.next_review_time = now + 1 * 60 * 1000;

        assert_eq!(card.memory_depth, 0);
        assert_eq!(card.interval_mins, 1);
        assert_eq!(card.next_review_time, 2000 + 60 * 1000);
    }

    #[test]
    fn test_due_cards_priority_sorting() {
        let now = 5000;
        
        let card1 = Card {
            id: "1".into(),
            front: "Q1".into(),
            back: "A1".into(),
            create_time: 1000,
            memory_depth: 2,
            interval_mins: 30,
            next_review_time: 4000, // due
        };
        
        let card2 = Card {
            id: "2".into(),
            front: "Q2".into(),
            back: "A2".into(),
            create_time: 1000,
            memory_depth: 0, // lower memory depth, higher priority
            interval_mins: 0,
            next_review_time: 4500, // due
        };

        let card3 = Card {
            id: "3".into(),
            front: "Q3".into(),
            back: "A3".into(),
            create_time: 1000,
            memory_depth: 1,
            interval_mins: 5,
            next_review_time: 6000, // NOT due
        };

        let mut due_cards: Vec<Card> = vec![card1, card2, card3].into_iter()
            .filter(|c| c.next_review_time <= now)
            .collect();

        assert_eq!(due_cards.len(), 2);

        // Sort: memory_depth ASC, then next_review_time ASC
        due_cards.sort_by(|a, b| {
            a.memory_depth.cmp(&b.memory_depth)
                .then(a.next_review_time.cmp(&b.next_review_time))
        });

        // card2 has memory depth 0, card1 has memory depth 2.
        // Therefore, card2 must be first!
        assert_eq!(due_cards[0].id, "2");
        assert_eq!(due_cards[1].id, "1");
    }
}
