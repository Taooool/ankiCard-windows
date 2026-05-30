// ================= TAURI API IMPORT =================
/**
 * 导入 Tauri API 方法
 */
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ================= STATE MANAGEMENT =================
/**
 * 缓存的全部卡片列表
 * @type {Array<Object>}
 */
let allCards = [];

/**
 * 当前选中的卡片 ID
 * @type {String|null}
 */
let selectedCardId = null;

/**
 * 当前排序模式
 * @type {'depth-asc'|'depth-desc'}
 */
let currentSortMode = 'depth-asc';

/**
 * 搜索关键词
 * @type {String}
 */
let searchQuery = '';

/**
 * 当前正在复习的提醒卡片实体
 * @type {Object|null}
 */
let currentReminderCard = null;

/**
 * 倒计时循环执行句柄 ID
 * @type {number|null}
 */
let countdownTimerId = null;

/**
 * 全局配置缓存
 * @type {Object}
 */
let appConfig = { is_enabled: true };

/**
 * 是否开启批量管理选择模式
 * @type {boolean}
 */
let isBatchMode = false;

/**
 * 批量选择中选中的卡片 ID 集合
 * @type {Set<String>}
 */
let batchSelectedIds = new Set();


// ================= UTILITY FUNCTIONS =================

/**
 * 根据卡片记忆深度熟练度获取对应的颜色等级类名
 * @param {number} depth 记忆深度值 (0-100)
 * @returns {string} 样式对应的 CSS 样式类名
 */
function getDepthBadgeClass(depth) {
  if (depth === 0) return 'depth-0';
  if (depth < 40) return 'depth-low';
  if (depth < 80) return 'depth-medium';
  return 'depth-high';
}

// ================= ROUTER / WINDOW INIT =================
/**
 * 缓存当前所在的窗口 Label 标识
 * @type {string}
 */
window.currentWindowLabel = 'main';

/**
 * 前端路由控制逻辑，通过 HASH 或 Window Label 进行视图分发
 */
function handleRoute() {
  const hash = window.location.hash || '#/';
  
  if (hash === '#/reminder') {
    window.currentWindowLabel = 'reminder';
    document.body.className = 'route-reminder';
    initReminderView();
  } else {
    window.currentWindowLabel = 'main';
    document.body.className = 'route-main';
    initMainView();
  }
}

/**
 * 初始化判断当前窗口所在的类型，防止路由闪烁
 */
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

/**
 * 获取当前排序模式下已排序的卡片克隆数组
 * 
 * 排序逻辑：
 * 1. 深度相同，按 ID 倒序排列（以代替时间排序）。
 * 2. 深度不同，按设定方向升序或降序。
 * @returns {Array<Object>} 排序后的卡片集合
 */
function getSortedCards() {
  let sorted = [...allCards];
  if (currentSortMode === 'depth-asc') {
    sorted.sort((a, b) => a.memory_depth - b.memory_depth || b.id.localeCompare(a.id));
  } else if (currentSortMode === 'depth-desc') {
    sorted.sort((a, b) => b.memory_depth - a.memory_depth || b.id.localeCompare(a.id));
  }
  return sorted;
}

/**
 * 主界面视图的初始化动作
 */
async function initMainView() {
  stopCountdownTimer();
  await loadCards();
  await loadTimerConfig();
  startCountdownTimer();
  
  // 默认选中第一条卡片
  if (allCards.length > 0 && !selectedCardId) {
    const sorted = getSortedCards();
    selectCard(sorted[0].id);
  } else if (selectedCardId) {
    selectCard(selectedCardId);
  } else {
    renderCardDetail(null);
  }
}

/**
 * 后端调用，从本地文件系统加载卡片列表
 */
async function loadCards() {
  try {
    allCards = await invoke('get_cards');
    renderCardsList();
  } catch (err) {
    console.error('Failed to load cards:', err);
  }
}

/**
 * 重新渲染并填充左侧侧边栏卡片列表 DOM 结构
 */
function renderCardsList() {
  const listEl = document.getElementById('cards-list');
  listEl.innerHTML = '';
  
  const sorted = getSortedCards();
  let filtered = sorted.filter(card => {
    const q = searchQuery.toLowerCase();
    return card.front.toLowerCase().includes(q) || card.back.toLowerCase().includes(q);
  });
  
  filtered.forEach(card => {
    const li = document.createElement('li');
    const isChecked = batchSelectedIds.has(card.id);
    li.className = `card-item ${card.id === selectedCardId ? 'selected' : ''} ${isChecked ? 'checked' : ''}`;
    li.dataset.id = card.id;
    
    const depthClass = getDepthBadgeClass(card.memory_depth);
    
    li.innerHTML = `
      <div class="card-item-checkbox-wrap">
        <input type="checkbox" class="card-item-checkbox" ${isChecked ? 'checked' : ''} />
      </div>
      <div class="card-item-content">
        <div class="card-item-title">${escapeHtml(card.front)}</div>
        <div class="card-item-meta">
          <span class="badge-depth ${depthClass}">深度: ${card.memory_depth}%</span>
        </div>
      </div>
    `;
    
    li.addEventListener('click', (e) => {
      if (isBatchMode) {
        e.preventDefault();
        toggleBatchSelect(card.id);
      } else {
        selectCard(card.id);
      }
    });
    
    const checkbox = li.querySelector('.card-item-checkbox');
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleBatchSelect(card.id);
    });
    
    listEl.appendChild(li);
  });
}

/**
 * 在列表中高亮并选中单张卡片以载入详情视图
 * @param {string} id 卡片 ID
 */
function selectCard(id) {
  selectedCardId = id;
  
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

/**
 * 刷新并渲染右侧卡片详情区
 * @param {Object|null} card 选定的卡片对象，若无则渲染空白提示态
 */
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
}

/**
 * 对 HTML 特殊符号执行安全过滤字符转义，防止 XSS 攻击
 * @param {string} str 输入的源字符串
 * @returns {string} 转义过滤后的安全 HTML 实体内容
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.innerText = str;
  return div.innerHTML;
}

/**
 * 辅助函数：根据总秒数反向将配置同步设定到前端输入框及下拉框中
 * @param {number} totalSecs 时间配置秒数
 */
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

/**
 * 从后端加载定时器的配置数据并更新界面
 */
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

/**
 * 前端配置发生变动时，收集并上传定时提醒配置参数
 */
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

/**
 * 主动拉取下一次弹窗的时间，换算并更新前端计时面板 UI 视图
 */
async function updateCountdownUI() {
  const isEnabled = document.getElementById('timer-toggle-switch').checked;
  const statusEl = document.getElementById('countdown-status');
  
  if (!isEnabled) {
    statusEl.textContent = '自动提醒已禁用';
    return;
  }
  
  try {
    const nextTrigger = await invoke('get_next_trigger_time');
    
    // 挂起态处理：当前提醒窗口已开启，定时轮询休眠中
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

/**
 * 启动前端的倒计时轮询计时面板
 */
function startCountdownTimer() {
  stopCountdownTimer();
  updateCountdownUI();
  countdownTimerId = setInterval(updateCountdownUI, 1000);
}

/**
 * 停止前端的倒计时轮询
 */
function stopCountdownTimer() {
  if (countdownTimerId) {
    clearInterval(countdownTimerId);
    countdownTimerId = null;
  }
}

// ================= CRUD CARD MODAL LOGIC =================

/**
 * 展示用于添加新卡片的模态框
 */
function showAddCardModal() {
  document.getElementById('modal-title').textContent = '添加记忆卡片';
  document.getElementById('modal-card-id').value = '';
  document.getElementById('card-front-input').value = '';
  document.getElementById('card-back-input').value = '';
  document.getElementById('card-modal').classList.add('active');
  document.getElementById('card-front-input').focus();
}

/**
 * 展示编辑现有卡片的模态框并预填充数据
 * @param {Object} card 目标卡片实体
 */
function showEditCardModal(card) {
  document.getElementById('modal-title').textContent = '编辑记忆卡片';
  document.getElementById('modal-card-id').value = card.id;
  document.getElementById('card-front-input').value = card.front;
  document.getElementById('card-back-input').value = card.back;
  document.getElementById('card-modal').classList.add('active');
  document.getElementById('card-front-input').focus();
}

/**
 * 关闭卡片编辑/新增弹窗模态框
 */
function hideCardModal() {
  document.getElementById('card-modal').classList.remove('active');
}

/**
 * 处理模态框的提交行为，异步调用后端增加/修改接口并局部刷新列表
 * @param {Event} e 表单 submit 拦截事件
 */
async function handleModalSubmit(e) {
  e.preventDefault();
  
  const id = document.getElementById('modal-card-id').value;
  const front = document.getElementById('card-front-input').value.trim();
  const back = document.getElementById('card-back-input').value.trim();
  
  if (!front || !back) return;
  
  try {
    if (id) {
      await invoke('edit_card', { id, front, back });
    } else {
      await invoke('add_card', { front, back });
    }
    hideCardModal();
    await loadCards();
    if (id) selectCard(id);
  } catch (err) {
    alert('保存失败: ' + err);
  }
}

/**
 * 删除当前高亮选中的单张卡片
 */
async function deleteSelectedCard() {
  if (!selectedCardId) return;
  
  const card = allCards.find(c => c.id === selectedCardId);
  if (!card) return;
  
  if (confirm(`确定要删除卡片 "${card.front.substring(0, 15)}..." 吗？`)) {
    try {
      await invoke('delete_card', { id: selectedCardId });
      selectedCardId = null;
      await loadCards();
      
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

/**
 * 唤醒并初始化复习弹窗内的信息展示
 */
async function initReminderView() {
  document.getElementById('flip-card-inner').classList.remove('flipped');
  await loadNextReminderCard();
  renderReminderCard();
}

/**
 * 向后端请求基于加权冷却抽取算法推选的下一张卡片
 */
async function loadNextReminderCard() {
  try {
    currentReminderCard = await invoke('get_reminder_card');
  } catch (err) {
    console.error('Failed to load reminder card:', err);
    currentReminderCard = null;
  }
}

/**
 * 前端复习弹窗组件卡片内容填充渲染
 */
function renderReminderCard() {
  const activeState = document.getElementById('reminder-active-state');
  const innerCard = document.getElementById('flip-card-inner');
  
  innerCard.classList.remove('flipped');
  
  if (!currentReminderCard) {
    closeWindow();
    return;
  }
  
  activeState.classList.add('active');
  
  document.getElementById('popup-queue-badge').textContent = `共 ${allCards.length || '?'} 张`;
  document.getElementById('popup-depth-badge').textContent = `深度 ${currentReminderCard.memory_depth}%`;
  document.getElementById('popup-front-text').textContent = currentReminderCard.front;
  
  document.getElementById('popup-back-question-ref').textContent = currentReminderCard.front;
  document.getElementById('popup-back-text').textContent = currentReminderCard.back;
}

/**
 * 模拟卡片翻转动作，翻转视角以显示答案面
 */
function revealAnswer() {
  document.getElementById('flip-card-inner').classList.add('flipped');
}

/**
 * 上报卡片复习判定状态（记得/不记得），更新数据库后由后端销毁提醒窗口
 * @param {boolean} remembered 用户是否记得当前卡片
 */
async function handleReviewResult(remembered) {
  if (!currentReminderCard) return;
  
  const cardId = currentReminderCard.id;
  
  try {
    await invoke('review_card', { id: cardId, remembered });
    await closeWindow();
  } catch (err) {
    console.error('Failed to submit review:', err);
  }
}

/**
 * 调用后端主动销毁关闭当前复习窗口，通知计时器解除挂起状态重新倒计时
 */
async function closeWindow() {
  try {
    await invoke('close_reminder_window');
  } catch (e) {
    console.error('Failed to close window:', e);
  }
}


// ================= BATCH MODE LOGIC =================

/**
 * 切换侧边栏为批量管理模式
 * 
 * 切换逻辑：
 * 1. 切换 isBatchMode 状态，清空选择缓存。
 * 2. 给 body 挂载 .batch-mode 样式类激活 CSS 联动（展示 checkbox，通过 slideUp 显示批量控制面板，隐藏定时器）。
 * 3. 禁用/启用卡片右侧详情区的独立编辑和删除按钮，引导用户专注于勾选。
 */
function toggleBatchMode() {
  isBatchMode = !isBatchMode;
  batchSelectedIds.clear();
  
  const editBtn = document.getElementById('edit-card-btn');
  const deleteBtn = document.getElementById('delete-card-btn');
  
  if (isBatchMode) {
    document.body.classList.add('batch-mode');
    document.getElementById('batch-toggle-btn').textContent = '退出批量';
    if (editBtn) editBtn.disabled = true;
    if (deleteBtn) deleteBtn.disabled = true;
  } else {
    document.body.classList.remove('batch-mode');
    document.getElementById('batch-toggle-btn').textContent = '批量管理';
    if (editBtn) editBtn.disabled = false;
    if (deleteBtn) deleteBtn.disabled = false;
  }
  
  updateBatchActionBar();
  renderCardsList();
}

/**
 * 批量模式下切换单张卡片的勾选选中状态
 * @param {string} id 卡片唯一标识 ID
 */
function toggleBatchSelect(id) {
  if (batchSelectedIds.has(id)) {
    batchSelectedIds.delete(id);
  } else {
    batchSelectedIds.add(id);
  }
  updateBatchActionBar();
  
  const cardEl = document.querySelector(`.card-item[data-id="${id}"]`);
  if (cardEl) {
    const checkbox = cardEl.querySelector('.card-item-checkbox');
    if (batchSelectedIds.has(id)) {
      cardEl.classList.add('checked');
      if (checkbox) checkbox.checked = true;
    } else {
      cardEl.classList.remove('checked');
      if (checkbox) checkbox.checked = false;
    }
  }
}

/**
 * 更新底部批量管理操作面板的选中计数和全选按钮指示状态
 */
function updateBatchActionBar() {
  const countEl = document.getElementById('batch-select-count');
  if (countEl) {
    countEl.textContent = batchSelectedIds.size;
  }
  
  const selectAllBtn = document.getElementById('batch-select-all-btn');
  if (selectAllBtn) {
    const sorted = getSortedCards();
    const filtered = sorted.filter(card => {
      const q = searchQuery.toLowerCase();
      return card.front.toLowerCase().includes(q) || card.back.toLowerCase().includes(q);
    });
    
    const isAllSelected = filtered.length > 0 && filtered.every(card => batchSelectedIds.has(card.id));
    selectAllBtn.textContent = isAllSelected ? '取消全选' : '全选';
  }
}

/**
 * 一键勾选或一键取消当前侧边栏已过滤出的全部可见卡片
 */
function handleBatchSelectAll() {
  const sorted = getSortedCards();
  const filtered = sorted.filter(card => {
    const q = searchQuery.toLowerCase();
    return card.front.toLowerCase().includes(q) || card.back.toLowerCase().includes(q);
  });
  
  const isAllSelected = filtered.length > 0 && filtered.every(card => batchSelectedIds.has(card.id));
  
  if (isAllSelected) {
    filtered.forEach(card => batchSelectedIds.delete(card.id));
  } else {
    filtered.forEach(card => batchSelectedIds.add(card.id));
  }
  
  updateBatchActionBar();
  renderCardsList();
}

/**
 * 调用后端 API，批量删除所有已勾选选中的卡片，并在成功后重置为标准单选查看模式
 */
async function handleBatchDelete() {
  if (batchSelectedIds.size === 0) {
    alert('请先选择要删除的卡片');
    return;
  }
  
  if (confirm(`确定要删除选中的 ${batchSelectedIds.size} 张卡片吗？`)) {
    try {
      const idsToDelete = Array.from(batchSelectedIds);
      await invoke('delete_cards', { ids: idsToDelete });
      
      batchSelectedIds.clear();
      isBatchMode = false;
      document.body.classList.remove('batch-mode');
      document.getElementById('batch-toggle-btn').textContent = '批量管理';
      
      const editBtn = document.getElementById('edit-card-btn');
      const deleteBtn = document.getElementById('delete-card-btn');
      if (editBtn) editBtn.disabled = false;
      if (deleteBtn) deleteBtn.disabled = false;
      
      selectedCardId = null;
      await loadCards();
      
      if (allCards.length > 0) {
        const sorted = getSortedCards();
        selectCard(sorted[0].id);
      } else {
        renderCardDetail(null);
      }
    } catch (err) {
      alert('批量删除失败: ' + err);
    }
  }
}

// ================= IMPORT CARDS LOGIC =================

/**
 * 客户端纯文本卡片解析器
 * 
 * 扫描机制：
 * 1. 利用换行符切割文本得到行数组。
 * 2. 行循环中自动使用 trim() 过滤前置空白行。
 * 3. 第一行捕捉为 Front 问题，紧接着的第二行捕捉为 Back 答案。
 * 4. 之后以累加 3 行的机制跳至下一个卡片块，自动规避格式留空或在起始时由 skip 过滤不规则空白。
 * @param {string} text 读取到的原始纯文本内容
 * @returns {Array<Object>} 成功解析的卡片 Front/Back 集合列表
 */
function parseImportedCards(text) {
  const lines = text.split(/\r?\n/);
  const cards = [];
  
  let i = 0;
  while (i < lines.length) {
    while (i < lines.length && lines[i].trim() === "") {
      i++;
    }
    if (i >= lines.length) break;
    
    const front = lines[i].trim();
    const back = (i + 1 < lines.length) ? lines[i + 1].trim() : "";
    
    if (front && back) {
      cards.push({ front, back });
    }
    
    i += 3;
  }
  return cards;
}

/**
 * 监听并读取文件上传数据流，解析完毕后发起 Tauri 批量导入请求
 * @param {Event} e 文件选择变更事件
 */
async function handleImportCards(e) {
  const fileInput = document.getElementById('import-file-input');
  const file = fileInput.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = async (event) => {
    const text = event.target.result;
    const newCards = parseImportedCards(text);
    
    if (newCards.length === 0) {
      alert('未在此文件中解析出符合格式的卡片！\n格式要求：\n第一行为问题\n第二行为答案\n第三行留空（依次循环）');
      fileInput.value = '';
      return;
    }
    
    if (confirm(`成功解析到 ${newCards.length} 张卡片，是否确认导入？`)) {
      try {
        const pairs = newCards.map(c => [c.front, c.back]);
        const count = await invoke('import_cards', { newCards: pairs });
        alert(`成功导入 ${count} 张卡片！`);
        
        await loadCards();
        
        if (allCards.length > 0) {
          const sorted = getSortedCards();
          selectCard(sorted[0].id);
        }
      } catch (err) {
        alert('导入卡片失败: ' + err);
      }
    }
    fileInput.value = '';
  };
  reader.readAsText(file);
}

// ================= GLOBAL EVENT INITIALIZATION =================
window.addEventListener('DOMContentLoaded', () => {
  initWindow();
  window.addEventListener('hashchange', handleRoute);
  
  // ----- MAIN VIEW EVENTS -----
  
  document.getElementById('search-input').addEventListener('input', (e) => {
    searchQuery = e.target.value;
    renderCardsList();
  });
  
  document.getElementById('sort-depth-asc-btn').addEventListener('click', () => {
    document.getElementById('sort-depth-asc-btn').classList.add('active');
    document.getElementById('sort-depth-desc-btn').classList.remove('active');
    currentSortMode = 'depth-asc';
    renderCardsList();
  });
  
  document.getElementById('sort-depth-desc-btn').addEventListener('click', () => {
    document.getElementById('sort-depth-desc-btn').classList.add('active');
    document.getElementById('sort-depth-asc-btn').classList.remove('active');
    currentSortMode = 'depth-desc';
    renderCardsList();
  });
  
  document.getElementById('add-card-float-btn').addEventListener('click', showAddCardModal);
  
  document.getElementById('close-modal-btn').addEventListener('click', hideCardModal);
  document.getElementById('modal-cancel-btn').addEventListener('click', hideCardModal);
  document.getElementById('card-form').addEventListener('submit', handleModalSubmit);
  
  document.getElementById('edit-card-btn').addEventListener('click', () => {
    const card = allCards.find(c => c.id === selectedCardId);
    if (card) showEditCardModal(card);
  });
  
  document.getElementById('delete-card-btn').addEventListener('click', deleteSelectedCard);
  
  document.getElementById('batch-toggle-btn').addEventListener('click', toggleBatchMode);
  document.getElementById('batch-select-all-btn').addEventListener('click', handleBatchSelectAll);
  document.getElementById('batch-cancel-btn').addEventListener('click', toggleBatchMode);
  document.getElementById('batch-delete-btn').addEventListener('click', handleBatchDelete);
  
  const importBtn = document.getElementById('import-cards-btn');
  if (importBtn) {
    importBtn.addEventListener('click', () => {
      document.getElementById('import-file-input').click();
    });
  }
  const importInput = document.getElementById('import-file-input');
  if (importInput) {
    importInput.addEventListener('change', handleImportCards);
  }
  
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
  
  listen('cards-updated', () => {
    loadCards();
  });
  
  listen('config-updated', (event) => {
    appConfig = event.payload;
    document.getElementById('timer-toggle-switch').checked = appConfig.is_enabled;
    updateTimerUIFromSeconds(appConfig.interval_secs);
    updateCountdownUI();
  });
  
  listen('reload-card', () => {
    if (window.currentWindowLabel === 'reminder') {
      initReminderView();
    }
  });
});
