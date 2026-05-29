use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::fs;
use std::path::PathBuf;
use tauri::{State, Manager, AppHandle, Emitter, WebviewWindowBuilder, WebviewUrl};
use chrono::Local;
use tokio::time::{sleep, Duration};

fn default_true() -> bool {
    true
}

fn default_interval_secs() -> u32 {
    600 // 10 minutes * 60 seconds
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Card {
    pub id: String,
    pub front: String,
    pub back: String,
    #[serde(default)]
    pub memory_depth: u32,         // remember rate (0-100)
    #[serde(default)]
    pub popup_count: u32,          // popup count
    #[serde(default)]
    pub remember_count: u32,       // remember count
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppConfig {
    #[serde(default = "default_interval_secs")]
    pub interval_secs: u32,       // Timer interval in seconds
    #[serde(default = "default_true")]
    pub is_enabled: bool,         // Is auto-reminder enabled
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            interval_secs: 600,
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
    pub programmatic_close: bool, // true when close is triggered by code, not by user
    pub last_reviewed_id: Option<String>,
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
        .title("复习")
        .inner_size(460.0, 320.0)
        .center()
        .always_on_top(true)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .decorations(true);
        
        let window = builder.build().map_err(|e| e.to_string())?;
        let _ = window.set_background_color(Some(tauri::window::Color(9, 13, 22, 255)));
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
        memory_depth: 0,
        popup_count: 0,
        remember_count: 0,
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
    inner.last_reviewed_id = Some(id.clone());
    
    let cloned_card = if let Some(card) = inner.cards.iter_mut().find(|c| c.id == id) {
        card.popup_count += 1;
        if remembered {
            card.remember_count += 1;
        }
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

#[tauri::command]
fn get_reminder_card(state: State<'_, AppState>) -> Option<Card> {
    let inner = state.inner.lock().unwrap();
    
    if inner.cards.is_empty() {
        return None;
    }
    
    // Filter out the last reviewed card if there are multiple cards
    let available_cards: Vec<&Card> = if inner.cards.len() > 1 {
        if let Some(ref last_id) = inner.last_reviewed_id {
            inner.cards.iter().filter(|c| c.id != *last_id).collect()
        } else {
            inner.cards.iter().collect()
        }
    } else {
        inner.cards.iter().collect()
    };
    
    // Calculate total weight of available cards (weight = 101 - memory_depth)
    let total_weight: u32 = available_cards.iter().map(|c| 101 - c.memory_depth).sum();
    
    // Choose a random value in range [0, total_weight)
    let mut random_val = rand::random_range(0..total_weight);
    
    // Select the card corresponding to the random value
    for card in &available_cards {
        let weight = 101 - card.memory_depth;
        if random_val < weight {
            return Some((*card).clone());
        }
        random_val -= weight;
    }
    
    available_cards.last().map(|c| (*c).clone())
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



#[tauri::command]
async fn get_window_label(window: tauri::Window) -> String {
    window.label().to_string()
}

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
            
            tauri::async_runtime::spawn(async move {
                loop {
                    sleep(Duration::from_secs(1)).await;
                    
                    let mut trigger_needed = false;
                    let state = app_handle.state::<AppState>();
                    {
                        let mut inner = state.inner.lock().unwrap();
                        let now = Local::now().timestamp_millis();
                        
                        // Check if reminder window is currently open
                        let has_reminder_window = app_handle.get_webview_window("reminder").is_some();
                        if has_reminder_window {
                            // Freeze timer at 0 when reminder window is open
                            if inner.next_trigger_time != 0 {
                                inner.next_trigger_time = 0;
                                if let Some(main) = app_handle.get_webview_window("main") {
                                    let _ = main.emit("config-updated", inner.config.clone());
                                }
                            }
                        } else {
                            // If timer was frozen, start fresh countdown from now
                            if inner.next_trigger_time == 0 {
                                inner.next_trigger_time = now + (inner.config.interval_secs as i64) * 1000;
                                if let Some(main) = app_handle.get_webview_window("main") {
                                    let _ = main.emit("config-updated", inner.config.clone());
                                }
                            }
                            
                            // Check for periodic timer trigger
                            if inner.config.is_enabled && now >= inner.next_trigger_time {
                                trigger_needed = true;
                                inner.next_trigger_time = now + (inner.config.interval_secs as i64) * 1000;
                                
                                // Emit trigger updates to update countdown display
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
            if window.label() == "reminder" {
                if let tauri::WindowEvent::Destroyed = event {
                    let state = window.state::<AppState>();
                    let mut inner = state.inner.lock().unwrap();
                    if inner.programmatic_close {
                        // Code-initiated close (after review), reset flag
                        inner.programmatic_close = false;
                    } else {
                        // User clicked X → disable auto-reminder
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

        // Review 1: Remembered (popup -> 1, remember -> 1, depth -> 100)
        card.popup_count += 1;
        card.remember_count += 1;
        card.memory_depth = (card.remember_count * 100) / card.popup_count;

        assert_eq!(card.memory_depth, 100);
        assert_eq!(card.popup_count, 1);
        assert_eq!(card.remember_count, 1);

        // Review 2: Forgotten (popup -> 2, remember -> 1, depth -> 50)
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

        // Sort: memory_depth ASC, then id ASC
        cards.sort_by(|a, b| {
            a.memory_depth.cmp(&b.memory_depth)
                .then(a.id.cmp(&b.id))
        });

        // card2 has memory depth 0 (should be first)
        // card1 has memory depth 50 and id "2" (should be second)
        // card3 has memory depth 50 and id "3" (should be third)
        assert_eq!(cards[0].id, "1");
        assert_eq!(cards[1].id, "2");
        assert_eq!(cards[2].id, "3");
    }
}
