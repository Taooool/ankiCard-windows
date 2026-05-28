// ================= TAURI API IMPORT =================
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ================= STATE MANAGEMENT =================
let allCards = [];
let selectedCardId = null;
let currentSortMode = 'time'; // 'time' or 'depth'
let searchQuery = '';
let reminderQueue = [];
let currentReminderCard = null;
let countdownTimerId = null;

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

function formatDueTime(timestamp) {
  const diff = timestamp - Date.now();
  if (diff <= 0) {
    return { text: '待复习', isDue: true };
  }
  const mins = Math.floor(diff / 60000);
  if (mins < 1) {
    return { text: '即将到期', isDue: false };
  }
  if (mins < 60) {
    return { text: `${mins}分钟后`, isDue: false };
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return { text: `${hours}小时后`, isDue: false };
  }
  const days = Math.floor(hours / 24);
  return { text: `${days}天后`, isDue: false };
}

function getDepthBadgeClass(depth) {
  if (depth === 0) return 'depth-0';
  if (depth <= 2) return 'depth-low';
  if (depth <= 5) return 'depth-medium';
  return 'depth-high';
}

// ================= ROUTER / WINDOW INIT =================
window.currentWindowLabel = 'main'; // default fallback

function handleRoute() {
  const hash = window.location.hash || '#/';
  
  if (hash === '#/reminder') {
    document.body.className = 'route-reminder';
    window.currentWindowLabel = 'reminder';
    initReminderView();
  } else {
    document.body.className = 'route-main';
    window.currentWindowLabel = 'main';
    initMainView();
  }
}

async function initWindow() {
  try {
    const label = await invoke('get_window_label');
    window.currentWindowLabel = label;
    if (label === 'reminder') {
      document.body.className = 'route-reminder';
      await initReminderView();
    } else {
      document.body.className = 'route-main';
      await initMainView();
    }
  } catch (err) {
    console.error('Failed to resolve window label:', err);
    handleRoute();
  }
}

// ================= MAIN VIEW LOGIC =================
async function initMainView() {
  stopCountdownTimer();
  await loadCards();
  await loadTimerConfig();
  startCountdownTimer();
  
  // Select first card if available
  if (allCards.length > 0 && !selectedCardId) {
    selectCard(allCards[0].id);
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
  
  // Filter
  let filtered = allCards.filter(card => {
    const q = searchQuery.toLowerCase();
    return card.front.toLowerCase().includes(q) || card.back.toLowerCase().includes(q);
  });
  
  // Sort
  if (currentSortMode === 'time') {
    // Sort by create time descending
    filtered.sort((a, b) => b.create_time - a.create_time);
  } else if (currentSortMode === 'depth') {
    // Sort by memory depth descending, then time descending
    filtered.sort((a, b) => b.memory_depth - a.memory_depth || b.create_time - a.create_time);
  }
  
  filtered.forEach(card => {
    const li = document.createElement('li');
    li.className = `card-item ${card.id === selectedCardId ? 'selected' : ''}`;
    li.dataset.id = card.id;
    
    const dueInfo = formatDueTime(card.next_review_time);
    const dueClass = dueInfo.isDue ? 'card-item-due due-now' : 'card-item-due';
    const depthClass = getDepthBadgeClass(card.memory_depth);
    
    li.innerHTML = `
      <div class="card-item-title">${escapeHtml(card.front)}</div>
      <div class="card-item-meta">
        <span class="badge-depth ${depthClass}">深度: ${card.memory_depth}</span>
        <span class="${dueClass}">${dueInfo.text}</span>
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
  
  document.getElementById('detail-depth-val').textContent = card.memory_depth;
  document.getElementById('detail-interval-val').textContent = card.interval_mins === 0 ? '即时' : `${card.interval_mins}分钟`;
  document.getElementById('detail-front-text').textContent = card.front;
  document.getElementById('detail-back-text').textContent = card.back;
  document.getElementById('detail-create-time').textContent = formatDate(card.create_time);
  
  const dueInfo = formatDueTime(card.next_review_time);
  document.getElementById('detail-next-time').textContent = dueInfo.isDue ? '已到期，等待复习' : formatDate(card.next_review_time);
}

// Escape HTML utility
function escapeHtml(str) {
  const div = document.createElement('div');
  div.innerText = str;
  return div.innerHTML;
}

// ================= TIMER CONTROL LOGIC =================
async function loadTimerConfig() {
  try {
    const config = await invoke('get_timer_config');
    document.getElementById('timer-toggle-switch').checked = config.is_enabled;
    document.getElementById('timer-interval-input').value = config.interval_mins;
    updateCountdownUI();
  } catch (err) {
    console.error('Failed to load config:', err);
  }
}

async function saveTimerConfig() {
  const isEnabled = document.getElementById('timer-toggle-switch').checked;
  const intervalMins = parseInt(document.getElementById('timer-interval-input').value) || 10;
  
  try {
    await invoke('set_timer_config', { intervalMins, isEnabled });
    updateCountdownUI();
  } catch (err) {
    console.error('Failed to save config:', err);
  }
}

async function updateCountdownUI() {
  const isEnabled = document.getElementById('timer-toggle-switch').checked;
  const statusEl = document.getElementById('countdown-status');
  
  if (!isEnabled) {
    statusEl.textContent = '定时提醒已禁用';
    return;
  }
  
  try {
    const nextTrigger = await invoke('get_next_trigger_time');
    const diff = nextTrigger - Date.now();
    
    if (diff <= 0) {
      statusEl.textContent = '即将弹出提醒窗口...';
    } else {
      const totalSecs = Math.floor(diff / 1000);
      const mins = Math.floor(totalSecs / 60);
      const secs = totalSecs % 60;
      statusEl.textContent = `下次提醒倒计时: ${mins}分${secs}秒`;
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
      
      // Select first
      if (allCards.length > 0) {
        selectCard(allCards[0].id);
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
  await loadReminderQueue();
  renderNextReminderCard();
}

async function loadReminderQueue() {
  try {
    // Get all cards from backend
    const cards = await invoke('get_cards');
    const now = Date.now();
    // Filter due cards
    reminderQueue = cards.filter(c => c.next_review_time <= now);
    
    // Sort by Ebbinghaus priority
    reminderQueue.sort((a, b) => {
      return a.memory_depth - b.memory_depth || a.next_review_time - b.next_review_time;
    });
  } catch (err) {
    console.error('Failed to load reminder cards:', err);
  }
}

function renderNextReminderCard() {
  const activeState = document.getElementById('reminder-active-state');
  const successState = document.getElementById('reminder-success-state');
  const innerCard = document.getElementById('flip-card-inner');
  
  // Reset Card flip before switching content
  innerCard.classList.remove('flipped');
  
  if (reminderQueue.length === 0) {
    activeState.classList.remove('active');
    successState.classList.add('active');
    
    // Auto close window if this was triggered automatically
    document.getElementById('success-desc').textContent = "所有到期的记忆卡片均已处理完毕，保持优秀的学习节奏！";
    return;
  }
  
  activeState.classList.add('active');
  successState.classList.remove('active');
  
  currentReminderCard = reminderQueue[0];
  
  // Fill details
  document.getElementById('popup-queue-badge').textContent = `剩余 ${reminderQueue.length} 张`;
  document.getElementById('popup-depth-badge').textContent = `深度 ${currentReminderCard.memory_depth}`;
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
    // Call Rust to update card's Ebbinghaus status
    await invoke('review_card', { id: cardId, remembered });
    
    // Smooth transition: pop first item and load next
    reminderQueue.shift();
    
    // Transition effect
    const activeState = document.getElementById('reminder-active-state');
    activeState.style.opacity = '0';
    activeState.style.transition = 'opacity 0.2s ease';
    
    setTimeout(() => {
      renderNextReminderCard();
      activeState.style.opacity = '1';
    }, 200);
    
  } catch (err) {
    console.error('Failed to submit review:', err);
  }
}

async function triggerRandomReview() {
  try {
    const card = await invoke('get_random_card');
    if (card) {
      reminderQueue = [card];
      document.getElementById('reminder-success-state').classList.remove('active');
      document.getElementById('reminder-active-state').classList.add('active');
      renderNextReminderCard();
    } else {
      alert('数据库中没有卡片，请在主窗口添加卡片。');
    }
  } catch (err) {
    console.error('Random review failed:', err);
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
  document.getElementById('timer-interval-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      saveTimerConfig();
      e.target.blur();
    }
  });
  
  // Debug manual test trigger
  document.getElementById('test-reminder-btn').addEventListener('click', async () => {
    try {
      await invoke('trigger_reminder_manually');
    } catch (err) {
      alert('测试启动提醒窗口失败: ' + err);
    }
  });
  
  // ----- POPUP WINDOW EVENTS -----
  document.getElementById('view-answer-btn').addEventListener('click', revealAnswer);
  document.getElementById('remember-btn').addEventListener('click', () => handleReviewResult(true));
  document.getElementById('forget-btn').addEventListener('click', () => handleReviewResult(false));
  document.getElementById('random-review-btn').addEventListener('click', triggerRandomReview);
  document.getElementById('close-popup-btn').addEventListener('click', closeWindow);
  
  // ----- LISTEN TO TAURI GLOBAL EVENTS -----
  
  // Sync cards database updates
  listen('cards-updated', () => {
    loadCards();
    // If in reminder view, update the queue count
    if (window.currentWindowLabel === 'reminder') {
      loadReminderQueue().then(renderNextReminderCard);
    }
  });
  
  // Sync timer configurations
  listen('config-updated', (event) => {
    const config = event.payload;
    document.getElementById('timer-toggle-switch').checked = config.is_enabled;
    document.getElementById('timer-interval-input').value = config.interval_mins;
    updateCountdownUI();
  });
  
  // Popup reload command from Rust
  listen('reload-card', () => {
    if (window.currentWindowLabel === 'reminder') {
      initReminderView();
    }
  });
});
