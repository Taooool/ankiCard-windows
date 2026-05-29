// ================= TAURI API IMPORT =================
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ================= STATE MANAGEMENT =================
let allCards = [];
let selectedCardId = null;
let currentSortMode = 'time'; // 'time' or 'depth'
let searchQuery = '';
let currentReminderCard = null;
let countdownTimerId = null;
let appConfig = { is_enabled: true };

// ================= UTILITY FUNCTIONS =================
function formatDate(timestamp) {
  if (!timestamp) return '--';
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function getDepthBadgeClass(depth) {
  if (depth === 0) return 'depth-0';
  if (depth < 40) return 'depth-low';
  if (depth < 80) return 'depth-medium';
  return 'depth-high';
}

// ================= ROUTER / WINDOW INIT =================
window.currentWindowLabel = 'main'; // default fallback

function handleRoute() {
  const hash = window.location.hash || '#/';
  
  if (hash === '#/reminder') {
    window.currentWindowLabel = 'reminder';
    initReminderView().then(async () => {
      document.body.className = 'route-reminder';
      try {
        await invoke('show_reminder_window');
      } catch (e) {
        console.error('Failed to show window:', e);
      }
    });
  } else {
    window.currentWindowLabel = 'main';
    initMainView().then(() => {
      document.body.className = 'route-main';
    });
  }
}

async function initWindow() {
  try {
    const label = await invoke('get_window_label');
    window.currentWindowLabel = label;
    if (label === 'reminder') {
      await initReminderView();
      document.body.className = 'route-reminder';
      await invoke('show_reminder_window');
    } else {
      await initMainView();
      document.body.className = 'route-main';
    }
  } catch (err) {
    console.error('Failed to resolve window label:', err);
    handleRoute();
  }
}

// ================= MAIN VIEW LOGIC =================
function getSortedCards() {
  let sorted = [...allCards];
  if (currentSortMode === 'time') {
    sorted.sort((a, b) => b.create_time - a.create_time);
  } else if (currentSortMode === 'depth') {
    sorted.sort((a, b) => a.memory_depth - b.memory_depth || a.create_time - b.create_time);
  }
  return sorted;
}

async function initMainView() {
  stopCountdownTimer();
  await loadCards();
  await loadTimerConfig();
  startCountdownTimer();
  
  // Select first card if available (top-most in sorted list)
  if (allCards.length > 0 && !selectedCardId) {
    const sorted = getSortedCards();
    selectCard(sorted[0].id);
  } else if (selectedCardId) {
    selectCard(selectedCardId);
  } else {
    renderCardDetail(null);
  }
}

async function loadCards() {
  try {
    allCards = await invoke('get_cards');
    renderCardsList();
  } catch (err) {
    console.error('Failed to load cards:', err);
  }
}

function renderCardsList() {
  const listEl = document.getElementById('cards-list');
  
  listEl.innerHTML = '';
  
  // Sort and then Filter
  const sorted = getSortedCards();
  let filtered = sorted.filter(card => {
    const q = searchQuery.toLowerCase();
    return card.front.toLowerCase().includes(q) || card.back.toLowerCase().includes(q);
  });
  
  filtered.forEach(card => {
    const li = document.createElement('li');
    li.className = `card-item ${card.id === selectedCardId ? 'selected' : ''}`;
    li.dataset.id = card.id;
    
    const depthClass = getDepthBadgeClass(card.memory_depth);
    
    li.innerHTML = `
      <div class="card-item-title">${escapeHtml(card.front)}</div>
      <div class="card-item-meta">
        <span class="badge-depth ${depthClass}">深度: ${card.memory_depth}%</span>
      </div>
    `;
    
    li.addEventListener('click', () => selectCard(card.id));
    listEl.appendChild(li);
  });
}

function selectCard(id) {
  selectedCardId = id;
  
  // Update selection style
  document.querySelectorAll('.card-item').forEach(el => {
    if (el.dataset.id === id) {
      el.classList.add('selected');
    } else {
      el.classList.remove('selected');
    }
  });
  
  const card = allCards.find(c => c.id === id);
  renderCardDetail(card);
}

function renderCardDetail(card) {
  const emptyState = document.getElementById('empty-detail-state');
  const detailView = document.getElementById('card-detail-view');
  
  if (!card) {
    emptyState.classList.add('active');
    detailView.classList.remove('active');
    return;
  }
  
  emptyState.classList.remove('active');
  detailView.classList.add('active');
  
  document.getElementById('detail-depth-val').textContent = `${card.memory_depth}%`;
  document.getElementById('detail-popups-val').textContent = card.popup_count || 0;
  document.getElementById('detail-remembers-val').textContent = card.remember_count || 0;
  document.getElementById('detail-front-text').textContent = card.front;
  document.getElementById('detail-back-text').textContent = card.back;
  document.getElementById('detail-create-time').textContent = formatDate(card.create_time);
  

}

// Escape HTML utility
function escapeHtml(str) {
  const div = document.createElement('div');
  div.innerText = str;
  return div.innerHTML;
}

function updateTimerUIFromSeconds(totalSecs) {
  const intervalInput = document.getElementById('timer-interval-input');
  const unitSelect = document.getElementById('timer-unit-select');
  if (!intervalInput || !unitSelect) return;
  
  if (totalSecs % 60 === 0) {
    unitSelect.value = 'mins';
    intervalInput.value = totalSecs / 60;
  } else {
    unitSelect.value = 'secs';
    intervalInput.value = totalSecs;
  }
}

// ================= TIMER CONTROL LOGIC =================
async function loadTimerConfig() {
  try {
    appConfig = await invoke('get_timer_config');
    document.getElementById('timer-toggle-switch').checked = appConfig.is_enabled;
    updateTimerUIFromSeconds(appConfig.interval_secs);
    updateCountdownUI();
  } catch (err) {
    console.error('Failed to load config:', err);
  }
}

async function saveTimerConfig() {
  const isEnabled = document.getElementById('timer-toggle-switch').checked;
  const val = parseInt(document.getElementById('timer-interval-input').value) || 10;
  const unit = document.getElementById('timer-unit-select').value;
  const intervalSecs = val * (unit === 'mins' ? 60 : 1);
  
  try {
    appConfig = await invoke('set_timer_config', { intervalSecs, isEnabled });
    updateCountdownUI();
  } catch (err) {
    console.error('Failed to save config:', err);
  }
}

async function updateCountdownUI() {
  const isEnabled = document.getElementById('timer-toggle-switch').checked;
  const statusEl = document.getElementById('countdown-status');
  
  if (!isEnabled) {
    statusEl.textContent = '自动提醒已禁用';
    return;
  }
  
  try {
    const nextTrigger = await invoke('get_next_trigger_time');
    
    if (nextTrigger === 0) {
      statusEl.textContent = '复习进行中...';
      return;
    }
    
    const diff = nextTrigger - Date.now();
    
    if (diff <= 0) {
      statusEl.textContent = '即将弹出提醒窗口...';
    } else {
      const totalSecs = Math.floor(diff / 1000);
      const mins = Math.floor(totalSecs / 60);
      const secs = totalSecs % 60;
      
      statusEl.textContent = `倒计时: ${mins}分${secs}秒`;
    }
  } catch (err) {
    statusEl.textContent = '同步下次提醒时间失败';
  }
}

function startCountdownTimer() {
  stopCountdownTimer();
  updateCountdownUI();
  countdownTimerId = setInterval(updateCountdownUI, 1000);
}

function stopCountdownTimer() {
  if (countdownTimerId) {
    clearInterval(countdownTimerId);
    countdownTimerId = null;
  }
}

// ================= CRUD CARD MODAL LOGIC =================
function showAddCardModal() {
  document.getElementById('modal-title').textContent = '添加记忆卡片';
  document.getElementById('modal-card-id').value = '';
  document.getElementById('card-front-input').value = '';
  document.getElementById('card-back-input').value = '';
  document.getElementById('card-modal').classList.add('active');
  document.getElementById('card-front-input').focus();
}

function showEditCardModal(card) {
  document.getElementById('modal-title').textContent = '编辑记忆卡片';
  document.getElementById('modal-card-id').value = card.id;
  document.getElementById('card-front-input').value = card.front;
  document.getElementById('card-back-input').value = card.back;
  document.getElementById('card-modal').classList.add('active');
  document.getElementById('card-front-input').focus();
}

function hideCardModal() {
  document.getElementById('card-modal').classList.remove('active');
}

async function handleModalSubmit(e) {
  e.preventDefault();
  
  const id = document.getElementById('modal-card-id').value;
  const front = document.getElementById('card-front-input').value.trim();
  const back = document.getElementById('card-back-input').value.trim();
  
  if (!front || !back) return;
  
  try {
    if (id) {
      // Edit
      await invoke('edit_card', { id, front, back });
    } else {
      // Add
      await invoke('add_card', { front, back });
    }
    hideCardModal();
    await loadCards();
    if (id) selectCard(id);
  } catch (err) {
    alert('保存失败: ' + err);
  }
}

async function deleteSelectedCard() {
  if (!selectedCardId) return;
  
  const card = allCards.find(c => c.id === selectedCardId);
  if (!card) return;
  
  if (confirm(`确定要删除卡片 "${card.front.substring(0, 15)}..." 吗？`)) {
    try {
      await invoke('delete_card', { id: selectedCardId });
      selectedCardId = null;
      await loadCards();
      
      // Select first (top-most in sorted list)
      if (allCards.length > 0) {
        const sorted = getSortedCards();
        selectCard(sorted[0].id);
      } else {
        renderCardDetail(null);
      }
    } catch (err) {
      alert('删除失败: ' + err);
    }
  }
}

// ================= REMINDER WINDOW VIEW LOGIC =================
async function initReminderView() {
  // Clear any flips
  document.getElementById('flip-card-inner').classList.remove('flipped');
  await loadNextReminderCard();
  renderReminderCard();
}

async function loadNextReminderCard() {
  try {
    currentReminderCard = await invoke('get_reminder_card');
  } catch (err) {
    console.error('Failed to load reminder card:', err);
    currentReminderCard = null;
  }
}

function renderReminderCard() {
  const activeState = document.getElementById('reminder-active-state');
  const innerCard = document.getElementById('flip-card-inner');
  
  // Reset Card flip before switching content
  innerCard.classList.remove('flipped');
  
  if (!currentReminderCard) {
    // No cards at all — just close the window
    closeWindow();
    return;
  }
  
  activeState.classList.add('active');
  
  // Fill details
  document.getElementById('popup-queue-badge').textContent = `共 ${allCards.length || '?'} 张`;
  document.getElementById('popup-depth-badge').textContent = `深度 ${currentReminderCard.memory_depth}%`;
  document.getElementById('popup-front-text').textContent = currentReminderCard.front;
  
  document.getElementById('popup-back-question-ref').textContent = currentReminderCard.front;
  document.getElementById('popup-back-text').textContent = currentReminderCard.back;
}

function revealAnswer() {
  document.getElementById('flip-card-inner').classList.add('flipped');
}

async function handleReviewResult(remembered) {
  if (!currentReminderCard) return;
  
  const cardId = currentReminderCard.id;
  
  try {
    // Call Rust to update card's status
    await invoke('review_card', { id: cardId, remembered });
    
    // Close window immediately after reviewing one card
    await closeWindow();
  } catch (err) {
    console.error('Failed to submit review:', err);
  }
}


async function closeWindow() {
  try {
    await invoke('close_reminder_window');
  } catch (e) {
    console.error('Failed to close window:', e);
  }
}

// ================= GLOBAL EVENT INITIALIZATION =================
window.addEventListener('DOMContentLoaded', () => {
  // Resolve window type and initialize
  initWindow();
  window.addEventListener('hashchange', handleRoute);
  
  // ----- MAIN VIEW EVENTS -----
  
  // Search
  document.getElementById('search-input').addEventListener('input', (e) => {
    searchQuery = e.target.value;
    renderCardsList();
  });
  
  // Sorting
  document.getElementById('sort-time-btn').addEventListener('click', () => {
    document.getElementById('sort-time-btn').classList.add('active');
    document.getElementById('sort-depth-btn').classList.remove('active');
    currentSortMode = 'time';
    renderCardsList();
  });
  
  document.getElementById('sort-depth-btn').addEventListener('click', () => {
    document.getElementById('sort-depth-btn').classList.add('active');
    document.getElementById('sort-time-btn').classList.remove('active');
    currentSortMode = 'depth';
    renderCardsList();
  });
  
  // Floating Add Button
  document.getElementById('add-card-float-btn').addEventListener('click', showAddCardModal);
  
  // Modal buttons
  document.getElementById('close-modal-btn').addEventListener('click', hideCardModal);
  document.getElementById('modal-cancel-btn').addEventListener('click', hideCardModal);
  document.getElementById('card-form').addEventListener('submit', handleModalSubmit);
  
  // Actions
  document.getElementById('edit-card-btn').addEventListener('click', () => {
    const card = allCards.find(c => c.id === selectedCardId);
    if (card) showEditCardModal(card);
  });
  
  document.getElementById('delete-card-btn').addEventListener('click', deleteSelectedCard);
  
  // Timer configs
  document.getElementById('timer-toggle-switch').addEventListener('change', saveTimerConfig);
  document.getElementById('timer-interval-input').addEventListener('change', saveTimerConfig);
  document.getElementById('timer-unit-select').addEventListener('change', saveTimerConfig);
  document.getElementById('timer-interval-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      saveTimerConfig();
      e.target.blur();
    }
  });
  
  // ----- POPUP WINDOW EVENTS -----
  document.getElementById('view-answer-btn').addEventListener('click', revealAnswer);
  document.getElementById('remember-btn').addEventListener('click', () => handleReviewResult(true));
  document.getElementById('forget-btn').addEventListener('click', () => handleReviewResult(false));
  
  // ----- LISTEN TO TAURI GLOBAL EVENTS -----
  
  // Sync cards database updates
  listen('cards-updated', () => {
    loadCards();
  });
  
  // Sync timer configurations
  listen('config-updated', (event) => {
    appConfig = event.payload;
    document.getElementById('timer-toggle-switch').checked = appConfig.is_enabled;
    updateTimerUIFromSeconds(appConfig.interval_secs);
    updateCountdownUI();
  });
  
  // Popup reload command from Rust
  listen('reload-card', () => {
    if (window.currentWindowLabel === 'reminder') {
      initReminderView();
    }
  });
});
