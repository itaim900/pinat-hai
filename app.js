'use strict';

const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי']; // Sunday..Friday
const TASKS = [
  { key: 'feed', label: 'האכלה', icon: '🥕' },
  { key: 'water', label: 'השקיה', icon: '💧' },
  { key: 'clean', label: 'ניקיון', icon: '🧹' },
];
const STORAGE_KEY = 'petting-zoo-v1';
const TAB_KEY = 'petting-zoo-tab';

/* ---------- dates ---------- */

const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shortDate = (d) => `${d.getDate()}/${d.getMonth() + 1}`;

// The week runs Sunday..Friday. On Saturday the next week has already begun,
// so the board resets right after Friday ends.
function currentWeekStart(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = d.getDay();
  d.setDate(d.getDate() + (dow === 6 ? 1 : -dow));
  return d;
}

function todayIndex(now = new Date()) {
  const dow = now.getDay();
  return dow === 6 ? -1 : dow;
}

function dayDate(weekStartIso, i) {
  const [y, m, d] = weekStartIso.split('-').map(Number);
  return new Date(y, m - 1, d + i);
}

/* ---------- state ---------- */

let state;
let editMode = false;

function emptyBoard() {
  return DAYS.map(() => {
    const day = {};
    TASKS.forEach((t) => { day[t.key] = { childId: null, done: false }; });
    return day;
  });
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable */ }
}

function load() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (e) { /* ignore */ }
  if (saved && Array.isArray(saved.children) && Array.isArray(saved.board)) {
    state = saved;
  } else {
    state = { children: [], weekStart: null, board: emptyBoard() };
  }
  checkNewWeek();
}

function checkNewWeek() {
  const ws = isoDate(currentWeekStart());
  if (state.weekStart === ws) return false;
  state.weekStart = ws;
  state.board = emptyBoard();
  planWeek();
  save();
  return true;
}

const childById = (id) => state.children.find((c) => c.id === id);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function anyDoneThisWeek() {
  return state.board.some((day) => TASKS.some((t) => day[t.key].done));
}

// Fill every empty, not-done slot so each child gets about the same number of
// tasks, avoiding giving one child two tasks on the same day when possible.
function fillEmptySlots() {
  if (state.children.length === 0) return;
  const counts = new Map(state.children.map((c) => [c.id, 0]));
  state.board.forEach((day) => TASKS.forEach((t) => {
    const id = day[t.key].childId;
    if (counts.has(id)) counts.set(id, counts.get(id) + 1);
  }));

  state.board.forEach((day) => {
    TASKS.forEach((t) => {
      const slot = day[t.key];
      if (slot.childId || slot.done) return;
      const busyToday = new Set(TASKS.map((x) => day[x.key].childId).filter(Boolean));
      let pool = state.children.filter((c) => !busyToday.has(c.id));
      if (pool.length === 0) pool = state.children.slice();
      const min = Math.min(...pool.map((c) => counts.get(c.id)));
      const best = pool.filter((c) => counts.get(c.id) === min);
      const pick = best[Math.floor(Math.random() * best.length)];
      slot.childId = pick.id;
      counts.set(pick.id, counts.get(pick.id) + 1);
    });
  });
}

// Re-plan every task that isn't done yet.
function planWeek() {
  state.board.forEach((day) => TASKS.forEach((t) => {
    if (!day[t.key].done) day[t.key].childId = null;
  }));
  fillEmptySlots();
}

/* ---------- actions ---------- */

function addChild(name) {
  name = name.trim().replace(/\s+/g, ' ');
  if (!name) return;
  if (state.children.some((c) => c.name === name)) {
    showModal(`השם "${name}" כבר ברשימה.`, { okOnly: true });
    return;
  }
  state.children.push({ id: newId(), name, medals: 0 });
  // Before anyone has done a task this week, spread the work over everyone again.
  if (anyDoneThisWeek()) fillEmptySlots(); else planWeek();
  save();
  render();
}

async function removeChild(id) {
  const child = childById(id);
  if (!child) return;
  const ok = await showModal(`להסיר את ${child.name} מהרשימה?`);
  if (!ok) return;
  state.children = state.children.filter((c) => c.id !== id);
  state.board.forEach((day) => TASKS.forEach((t) => {
    const slot = day[t.key];
    if (slot.childId === id) { slot.childId = null; slot.done = false; }
  }));
  if (anyDoneThisWeek()) fillEmptySlots(); else planWeek();
  save();
  render();
}

async function toggleSlot(dayIdx, taskKey) {
  const slot = state.board[dayIdx][taskKey];
  const child = childById(slot.childId);
  if (!child) return;
  const task = TASKS.find((t) => t.key === taskKey);
  if (slot.done) {
    const ok = await showModal(`לבטל את הסימון של ${task.label} (${child.name})?`);
    if (!ok) return;
    slot.done = false;
    child.medals = Math.max(0, child.medals - 1);
  } else {
    slot.done = true;
    child.medals += 1;
    celebrate(child.name);
  }
  save();
  render();
}

function assignSlot(dayIdx, taskKey, childId) {
  const slot = state.board[dayIdx][taskKey];
  const prev = childById(slot.childId);
  if (slot.done && prev) prev.medals = Math.max(0, prev.medals - 1);
  slot.childId = childId || null;
  slot.done = false;
  save();
  render();
}

/* ---------- rendering ---------- */

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// 'up' = task done, 'down' = the task's day has passed and it wasn't done.
function hamster(kind, cls) {
  const img = el('img', `hamster ${cls || ''}`);
  img.src = `img/hamster-${kind}.svg`;
  img.alt = kind === 'up' ? 'בוצע' : 'לא בוצע';
  img.draggable = false;
  return img;
}

const isMissed = (dayIdx, slot) => !slot.done && dayIdx < todayIndex();

function renderHeader() {
  const start = dayDate(state.weekStart, 0);
  const end = dayDate(state.weekStart, DAYS.length - 1);
  document.getElementById('weekRange').textContent = `שבוע ${shortDate(start)} – ${shortDate(end)}`;
}

function emptyNotice(table, cols) {
  const tr = el('tr');
  const td = el('td', 'empty', 'עוד אין ילדים ברשימה. הוסיפו שמות בלשונית "הילדים" ⚙️');
  td.colSpan = cols;
  tr.appendChild(td);
  table.appendChild(tr);
}

function renderBoard() {
  const table = document.getElementById('boardTable');
  table.replaceChildren();
  document.getElementById('editToggle').textContent = editMode ? '✅ סיום שינוי' : '✏️ שינוי שיבוץ';
  document.getElementById('boardHint').textContent = editMode
    ? 'בחרו מהרשימה מי יעשה כל משימה.'
    : 'לחצו על המשימה כשסיימתם – ותקבלו מדליית זהב! 🥇';

  const head = el('tr');
  head.appendChild(el('th', 'corner', 'יום'));
  TASKS.forEach((t) => {
    const th = el('th', `task-head task-${t.key}`);
    th.appendChild(el('span', 'task-icon', t.icon));
    th.appendChild(el('span', 'task-label', t.label));
    head.appendChild(th);
  });
  const thead = el('thead');
  thead.appendChild(head);
  table.appendChild(thead);

  const tbody = el('tbody');
  table.appendChild(tbody);
  if (state.children.length === 0) { emptyNotice(tbody, TASKS.length + 1); return; }

  const today = todayIndex();
  DAYS.forEach((dayName, i) => {
    const tr = el('tr', i === today ? 'today' : '');
    const th = el('th', 'day');
    th.appendChild(el('span', 'day-name', dayName));
    th.appendChild(el('span', 'day-date', shortDate(dayDate(state.weekStart, i))));
    if (i === today) th.appendChild(el('span', 'today-badge', 'היום'));
    tr.appendChild(th);

    TASKS.forEach((t) => {
      const slot = state.board[i][t.key];
      const child = childById(slot.childId);
      const td = el('td');
      if (editMode) {
        const sel = el('select', 'slot-select');
        sel.setAttribute('aria-label', `${t.label} ביום ${dayName}`);
        sel.appendChild(new Option('—', ''));
        state.children.forEach((c) => sel.appendChild(new Option(c.name, c.id, false, c.id === slot.childId)));
        sel.addEventListener('change', () => assignSlot(i, t.key, sel.value));
        td.appendChild(sel);
      } else {
        const missed = child && isMissed(i, slot);
        const btn = el('button', `slot task-${t.key}${slot.done ? ' done' : ''}${missed ? ' missed' : ''}`);
        btn.type = 'button';
        btn.appendChild(el('span', 'slot-name', child ? child.name : '—'));
        if (slot.done) btn.appendChild(hamster('up', 'slot-hamster'));
        else if (missed) btn.appendChild(hamster('down', 'slot-hamster'));
        else btn.appendChild(el('span', 'slot-status', t.icon));
        btn.disabled = !child;
        btn.setAttribute('aria-pressed', slot.done ? 'true' : 'false');
        btn.addEventListener('click', () => toggleSlot(i, t.key));
        td.appendChild(btn);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

function renderKids() {
  const table = document.getElementById('kidsTable');
  table.replaceChildren();
  const today = todayIndex();

  const head = el('tr');
  head.appendChild(el('th', 'corner', 'שם'));
  DAYS.forEach((d, i) => {
    const th = el('th', i === today ? 'today-col' : '');
    th.appendChild(el('span', 'day-name', d));
    th.appendChild(el('span', 'day-date', shortDate(dayDate(state.weekStart, i))));
    head.appendChild(th);
  });
  const medalHead = el('th', 'medal-col', '🥇');
  medalHead.title = 'מדליות השבוע';
  head.appendChild(medalHead);
  const thead = el('thead');
  thead.appendChild(head);
  table.appendChild(thead);

  const tbody = el('tbody');
  table.appendChild(tbody);
  if (state.children.length === 0) { emptyNotice(tbody, DAYS.length + 2); return; }

  state.children.forEach((c) => {
    const tr = el('tr');
    tr.appendChild(el('th', 'kid-name', c.name));
    let weekMedals = 0;
    DAYS.forEach((_, i) => {
      const td = el('td', i === today ? 'today-col' : '');
      const chips = el('div', 'chips');
      TASKS.forEach((t) => {
        const slot = state.board[i][t.key];
        if (slot.childId !== c.id) return;
        if (slot.done) weekMedals++;
        const missed = isMissed(i, slot);
        const chip = el('span', `chip${slot.done ? ' done' : ''}${missed ? ' missed' : ''}`);
        chip.appendChild(el('span', 'chip-icon', t.icon));
        if (slot.done) chip.appendChild(hamster('up', 'chip-hamster'));
        else if (missed) chip.appendChild(hamster('down', 'chip-hamster'));
        chip.title = t.label + (slot.done ? ' – בוצע' : missed ? ' – לא בוצע' : '');
        chips.appendChild(chip);
      });
      td.appendChild(chips);
      tr.appendChild(td);
    });
    tr.appendChild(el('td', 'medal-col', String(weekMedals)));
    tbody.appendChild(tr);
  });
}

function renderManage() {
  const list = document.getElementById('childList');
  list.replaceChildren();
  if (state.children.length === 0) {
    list.appendChild(el('li', 'empty', 'הרשימה ריקה – כתבו שם ולחצו "הוספה".'));
    return;
  }
  state.children.forEach((c) => {
    const li = el('li', 'child-row');
    li.appendChild(el('span', 'child-name', c.name));
    li.appendChild(el('span', 'child-medals', `🥇 ${c.medals}`));
    const del = el('button', 'btn-icon', '🗑️');
    del.type = 'button';
    del.setAttribute('aria-label', `הסרת ${c.name}`);
    del.addEventListener('click', () => removeChild(c.id));
    li.appendChild(del);
    list.appendChild(li);
  });
}

function render() {
  renderHeader();
  renderBoard();
  renderKids();
  renderManage();
}

/* ---------- tabs ---------- */

function showTab(name) {
  document.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
  try { localStorage.setItem(TAB_KEY, name); } catch (e) { /* ignore */ }
}

/* ---------- overlays ---------- */

let celebrateTimer;
function celebrate(name) {
  const box = document.getElementById('celebrate');
  document.getElementById('celebrateText').textContent = `כל הכבוד, ${name}! קיבלת מדליית זהב`;
  box.hidden = false;
  box.classList.remove('show');
  void box.offsetWidth; // restart animation
  box.classList.add('show');
  clearTimeout(celebrateTimer);
  celebrateTimer = setTimeout(() => { box.hidden = true; }, 1800);
}

function showModal(text, { okOnly = false } = {}) {
  const modal = document.getElementById('modal');
  const yes = document.getElementById('modalYes');
  const no = document.getElementById('modalNo');
  document.getElementById('modalText').textContent = text;
  yes.textContent = okOnly ? 'אישור' : 'כן';
  no.hidden = okOnly;
  modal.hidden = false;
  yes.focus();
  return new Promise((resolve) => {
    const close = (result) => {
      modal.hidden = true;
      yes.onclick = no.onclick = modal.onclick = null;
      resolve(result);
    };
    yes.onclick = () => close(true);
    no.onclick = () => close(false);
    modal.onclick = (e) => { if (e.target === modal) close(false); };
  });
}

/* ---------- init ---------- */

function init() {
  load();

  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  let savedTab = null;
  try { savedTab = localStorage.getItem(TAB_KEY); } catch (e) { /* ignore */ }
  showTab(['board', 'kids', 'manage'].includes(savedTab) ? savedTab : (state.children.length ? 'board' : 'manage'));

  document.getElementById('addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('nameInput');
    addChild(input.value);
    input.value = '';
    input.focus();
  });

  document.getElementById('editToggle').addEventListener('click', () => {
    editMode = !editMode;
    renderBoard();
  });

  document.getElementById('reshuffleBtn').addEventListener('click', async () => {
    if (state.children.length === 0) return;
    const ok = await showModal('לשבץ מחדש את כל המשימות שעוד לא בוצעו השבוע?');
    if (!ok) return;
    planWeek();
    save();
    render();
  });

  document.getElementById('resetMedalsBtn').addEventListener('click', async () => {
    const ok = await showModal('לאפס את כל המדליות של כל הילדים?');
    if (!ok) return;
    state.children.forEach((c) => { c.medals = 0; });
    save();
    render();
  });

  document.getElementById('celebrate').addEventListener('click', (e) => { e.currentTarget.hidden = true; });

  // Roll over to a new week while the app stays open.
  let lastDay = todayIndex();
  const tick = () => {
    const newWeek = checkNewWeek();
    if (newWeek || todayIndex() !== lastDay) { lastDay = todayIndex(); render(); }
  };
  setInterval(tick, 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

  render();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && location.hostname !== 'localhost') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
