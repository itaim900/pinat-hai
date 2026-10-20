import { firebaseConfig, FIRESTORE_DATABASE, SITE_URL } from './firebase-config.js';
import {
  initializeApp,
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, connectAuthEmulator,
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, deleteUser,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache,
  connectFirestoreEmulator, doc, onSnapshot, setDoc, updateDoc, deleteDoc, runTransaction,
  increment, deleteField, serverTimestamp,
} from './vendor/firebase.js';

const APP_NAME = 'פינת החי';
const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי']; // Sunday..Friday
const TASKS = [
  { key: 'feed', label: 'האכלה', icon: '🥕' },
  { key: 'water', label: 'השקיה', icon: '💧' },
  { key: 'clean', label: 'ניקיון', icon: '🧹' },
];
const CLASS_KEY = 'petting-zoo-class';
const LEGACY_KEY = 'petting-zoo-v1'; // board saved on the device by the first version
const TAB_KEY = 'petting-zoo-tab';
const SOUND_KEY = 'petting-zoo-sound';

/* ---------- small helpers ---------- */

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  remove(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};

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

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Class codes avoid look-alike characters (0/O, 1/I/L).
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newClassCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}
const normalizeCode = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const formatCode = (c) => (c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c);

/* ---------- Firebase ---------- */

const useEmulator = !firebaseConfig.projectId;
const fbApp = initializeApp(useEmulator
  ? { apiKey: 'demo-key', projectId: 'demo-pinat-hai', authDomain: 'demo-pinat-hai.firebaseapp.com' }
  : firebaseConfig);
const auth = initializeAuth(fbApp, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
auth.languageCode = 'he';
const databaseId = useEmulator ? '(default)' : FIRESTORE_DATABASE;
let db;
try {
  db = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }, databaseId);
} catch (e) {
  db = initializeFirestore(fbApp, { localCache: memoryLocalCache() }, databaseId);
}
if (useEmulator) {
  connectAuthEmulator(auth, `http://${location.hostname}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, location.hostname, 8080);
}

/* ---------- state ---------- */

let classId = null;  // code of the petting zoo this device shows
let cls = null;      // the class document: children, assign, done, medals, weekStart, teacherUid
let user = null;     // signed-in teacher, if any
let unsubscribe = null;
let editMode = false;
let tabChosen = false;

const classRef = () => doc(db, 'classes', classId);
const isTeacher = () => !!(user && cls && cls.teacherUid === user.uid);
const slotKey = (d, t) => `${d}_${t}`;
const slotOf = (d, t) => {
  const k = slotKey(d, t);
  return { key: k, childId: cls.assign[k] || null, done: !!cls.done[k] };
};
const childById = (id) => cls.children.find((c) => c.id === id);
const medalsOf = (id) => Math.max(0, cls.medals[id] || 0);
const anyDone = (done) => Object.values(done).some(Boolean);

function normalizeClass(data) {
  return {
    ...data,
    children: Array.isArray(data.children) ? data.children : [],
    assign: data.assign || {},
    done: data.done || {},
    medals: data.medals || {},
    weekStart: data.weekStart || isoDate(currentWeekStart()),
  };
}

/* ---------- planning ---------- */

// Returns a full assignment map. Slots already done keep their child (and, with
// keepUndone, so do all other valid slots); every other slot is filled so each
// child gets about the same number of tasks, avoiding two tasks on one day.
function planAssign(children, assign = {}, done = {}, keepUndone = false) {
  const valid = new Set(children.map((c) => c.id));
  const result = {};
  DAYS.forEach((_, d) => TASKS.forEach((t) => {
    const k = slotKey(d, t.key);
    const id = assign[k];
    result[k] = valid.has(id) && (done[k] || keepUndone) ? id : null;
  }));
  if (children.length === 0) return result;

  const counts = new Map(children.map((c) => [c.id, 0]));
  Object.values(result).forEach((id) => { if (id) counts.set(id, counts.get(id) + 1); });
  DAYS.forEach((_, d) => TASKS.forEach((t) => {
    const k = slotKey(d, t.key);
    if (result[k]) return;
    const busyToday = new Set(TASKS.map((x) => result[slotKey(d, x.key)]).filter(Boolean));
    let pool = children.filter((c) => !busyToday.has(c.id));
    if (pool.length === 0) pool = children.slice();
    const min = Math.min(...pool.map((c) => counts.get(c.id)));
    const best = pool.filter((c) => counts.get(c.id) === min);
    const pick = best[Math.floor(Math.random() * best.length)];
    result[k] = pick.id;
    counts.set(pick.id, counts.get(pick.id) + 1);
  }));
  return result;
}

/* ---------- writing to the shared board ---------- */

// Writes apply to the screen at once (and offline); errors from the server show as a message.
function write(promise) {
  promise.catch((e) => { console.error(e); toast(errorText(e)); });
}

async function toggleSlot(d, taskKey) {
  const s = slotOf(d, taskKey);
  const child = childById(s.childId);
  if (!child) return;
  const task = TASKS.find((t) => t.key === taskKey);
  if (s.done) {
    const ok = await showModal(`לבטל את הסימון של ${task.label} (${child.name})?`);
    if (!ok) return;
    write(updateDoc(classRef(), { [`done.${s.key}`]: false, [`medals.${child.id}`]: increment(-1) }));
  } else {
    playSuccess();
    celebrate(child.name);
    write(updateDoc(classRef(), { [`done.${s.key}`]: true, [`medals.${child.id}`]: increment(1) }));
  }
}

function addChild(name) {
  name = name.trim().replace(/\s+/g, ' ');
  if (!name) return;
  if (cls.children.some((c) => c.name === name)) {
    showModal(`השם "${name}" כבר ברשימה.`, { okOnly: true });
    return;
  }
  const children = [...cls.children, { id: newId(), name }];
  // Before anyone has done a task this week, spread the work over everyone again.
  const assign = anyDone(cls.done)
    ? planAssign(children, cls.assign, cls.done, true)
    : planAssign(children);
  write(updateDoc(classRef(), { children, assign }));
}

async function removeChild(id) {
  const child = childById(id);
  if (!child) return;
  const ok = await showModal(`להסיר את ${child.name} מהרשימה?`);
  if (!ok) return;
  const children = cls.children.filter((c) => c.id !== id);
  const done = { ...cls.done };
  Object.entries(cls.assign).forEach(([k, v]) => { if (v === id) done[k] = false; });
  const assign = anyDone(done) ? planAssign(children, cls.assign, done, true) : planAssign(children);
  write(updateDoc(classRef(), { children, assign, done, [`medals.${id}`]: deleteField() }));
}

function assignSlot(d, taskKey, childId) {
  const s = slotOf(d, taskKey);
  const update = { [`assign.${s.key}`]: childId || null, [`done.${s.key}`]: false };
  if (s.done && s.childId) update[`medals.${s.childId}`] = increment(-1);
  write(updateDoc(classRef(), update));
}

// Any device may start the new week; the transaction makes sure only one does.
let rolling = false;
async function checkNewWeek() {
  const ws = isoDate(currentWeekStart());
  if (!cls || cls.weekStart >= ws || rolling) return;
  rolling = true;
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(classRef());
      if (!snap.exists()) return;
      const data = normalizeClass(snap.data());
      if (data.weekStart >= ws) return;
      tx.update(classRef(), { weekStart: ws, done: {}, assign: planAssign(data.children) });
    });
  } catch (e) {
    console.warn('new week not started yet', e);
  } finally {
    rolling = false;
  }
}

/* ---------- joining and accounts ---------- */

function readLegacyChildren() {
  try {
    const saved = JSON.parse(store.get(LEGACY_KEY));
    return saved && Array.isArray(saved.children) ? saved.children : [];
  } catch (e) { return []; }
}

// The teacher signs in with the board code + a password only. Firebase needs an
// email-shaped login name, so we make one from the code; no real email is stored.
const adminLogin = (code) => `${code.toLowerCase()}@${fbApp.options.authDomain}`;
const codeOfUser = (u) => normalizeCode((u && u.email || '').split('@')[0]);

// Creates a new board and its teacher account (bringing along names saved by the old version).
async function createBoard(password) {
  const code = newClassCode();
  const cred = await createUserWithEmailAndPassword(auth, adminLogin(code), password);
  const legacy = readLegacyChildren();
  const children = legacy.map((c) => ({ id: c.id, name: c.name }));
  const medals = Object.fromEntries(legacy.map((c) => [c.id, c.medals || 0]));
  try {
    await setDoc(doc(db, 'classes', code), {
      name: APP_NAME,
      teacherUid: cred.user.uid,
      children,
      medals,
      weekStart: isoDate(currentWeekStart()),
      assign: planAssign(children),
      done: {},
      createdAt: serverTimestamp(),
    });
  } catch (e) {
    await deleteUser(cred.user).catch(() => {});
    throw e;
  }
  if (legacy.length) store.remove(LEGACY_KEY);
  return code;
}

function openClass(code) {
  if (unsubscribe) unsubscribe();
  classId = code;
  cls = null;
  store.set(CLASS_KEY, code);
  showLoading('מתחבר ללוח…');
  unsubscribe = onSnapshot(doc(db, 'classes', code), (snap) => {
    if (!snap.exists()) {
      if (snap.metadata.fromCache) return; // wait for the server's answer
      forgetClass();
      if (user && codeOfUser(user) === code) {
        // A teacher account whose board was already deleted: finish deleting it.
        deleteUser(user).catch(() => signOut(auth));
        showWelcome('החשבון וכל המידע נמחקו.');
      } else {
        showWelcome('לא מצאנו פינת חי עם הקוד הזה. בדקו את הקוד ונסו שוב.');
      }
      return;
    }
    cls = normalizeClass(snap.data());
    showScreen('app');
    if (!tabChosen) chooseFirstTab();
    render();
    checkNewWeek();
  }, (err) => {
    console.error(err);
    forgetClass();
    showWelcome(errorText(err));
  });
}

function forgetClass() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  classId = null;
  cls = null;
  tabChosen = false;
  store.remove(CLASS_KEY);
}

async function login() {
  const code = normalizeCode($('loginCode').value);
  const password = $('loginPassword').value;
  if (code.length !== 8) { showWelcome('הקלידו את קוד הלוח (8 תווים, למשל ABCD-1234).', 'login'); return; }
  if (!password) { showWelcome('הקלידו את סיסמת המורה.', 'login'); return; }
  showLoading('נכנסים…');
  try {
    await signInWithEmailAndPassword(auth, adminLogin(code), password);
    $('loginPassword').value = '';
    openClass(code);
  } catch (e) {
    showWelcome(errorText(e), 'login');
  }
}

async function create() {
  const password = $('createPassword').value;
  if (password.length < 6) { showWelcome('הסיסמה צריכה להיות לפחות 6 תווים.', 'create'); return; }
  if (password !== $('createPassword2').value) { showWelcome('שתי הסיסמאות לא זהות. נסו שוב.', 'create'); return; }
  showLoading('פותחים לוח חדש…');
  try {
    const code = await createBoard(password);
    $('createPassword').value = '';
    $('createPassword2').value = '';
    openClass(code);
  } catch (e) {
    console.error(e);
    showWelcome(errorText(e), 'create');
  }
}

async function deleteAccount() {
  const ok = await showModal('למחוק לצמיתות את חשבון המורה, את רשימת הילדים, השיבוץ והמדליות? אי אפשר לבטל את זה.');
  if (!ok) return;
  const u = auth.currentUser;
  if (!u) return;
  try {
    if (cls && cls.teacherUid === u.uid) await deleteDoc(classRef());
    forgetClass();
    await deleteUser(u);
    showWelcome('החשבון וכל המידע נמחקו.');
  } catch (e) {
    console.error(e);
    if (e.code === 'auth/requires-recent-login') {
      await signOut(auth);
      showWelcome('כל המידע נמחק. נשאר רק למחוק את חשבון המורה: היכנסו שוב עם הקוד והסיסמה ולחצו שוב על "מחיקת החשבון".');
    } else {
      toast(errorText(e));
    }
  }
}

async function shareLink() {
  const url = `${SITE_URL}?class=${classId}`;
  const text = `${APP_NAME} – הלוח השבועי שלנו. קוד: ${formatCode(classId)}`;
  try {
    if (navigator.share) { await navigator.share({ title: APP_NAME, text, url }); return; }
  } catch (e) {
    if (e.name === 'AbortError') return;
  }
  try {
    await navigator.clipboard.writeText(`${text}\n${url}`);
    toast('הקישור הועתק – אפשר להדביק אותו בוואטסאפ 👍');
  } catch (e) {
    showModal(`הקישור: ${url}`, { okOnly: true });
  }
}

function errorText(e) {
  const code = (e && e.code) || '';
  const map = {
    'auth/invalid-credential': 'הקוד או הסיסמה שגויים.',
    'auth/wrong-password': 'הקוד או הסיסמה שגויים.',
    'auth/user-not-found': 'הקוד או הסיסמה שגויים.',
    'auth/invalid-email': 'הקוד או הסיסמה שגויים.',
    'auth/email-already-in-use': 'משהו השתבש. נסו שוב.',
    'auth/weak-password': 'הסיסמה צריכה להיות לפחות 6 תווים.',
    'auth/missing-password': 'הקלידו את סיסמת המורה.',
    'auth/too-many-requests': 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.',
    'auth/network-request-failed': 'אין חיבור לאינטרנט. נסו שוב.',
    unavailable: 'אין חיבור לאינטרנט. נסו שוב.',
    'permission-denied': 'אין הרשאה לפעולה הזאת.',
  };
  return map[code] || 'משהו השתבש. נסו שוב.';
}

/* ---------- screens ---------- */

function showScreen(name) {
  $('screen-loading').hidden = name !== 'loading';
  $('screen-welcome').hidden = name !== 'welcome';
  $('screen-app').hidden = name !== 'app';
}

function showLoading(text) {
  $('loadingText').textContent = text;
  showScreen('loading');
}

// mode: 'login' or 'create' opens and focuses that teacher form.
function showWelcome(message, mode) {
  const msg = $('welcomeMsg');
  msg.textContent = message || '';
  msg.hidden = !message;
  $('welcomeBack').hidden = !cls;
  $('weekRange').textContent = '';
  $('loginCard').hidden = mode === 'create';
  $('createCard').hidden = mode !== 'create';
  if (classId && !$('loginCode').value) $('loginCode').value = formatCode(classId);
  showScreen('welcome');
  window.scrollTo(0, 0);
  if (mode === 'login') ($('loginCode').value ? $('loginPassword') : $('loginCode')).focus();
  if (mode === 'create') $('createPassword').focus();
}

/* ---------- rendering ---------- */

const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
};

// 'up' = task done, 'down' = the task's day has passed and it wasn't done.
function hamster(kind, extraClass) {
  const img = el('img', `hamster ${extraClass || ''}`);
  img.src = `img/hamster-${kind}.svg`;
  img.alt = kind === 'up' ? 'בוצע' : 'לא בוצע';
  img.draggable = false;
  return img;
}

const isMissed = (dayIdx, slot) => !slot.done && dayIdx < todayIndex();

function renderHeader() {
  const start = dayDate(cls.weekStart, 0);
  const end = dayDate(cls.weekStart, DAYS.length - 1);
  $('weekRange').textContent = `שבוע ${shortDate(start)} – ${shortDate(end)}`;
}

function emptyNotice(table, cols) {
  const tr = el('tr');
  const td = el('td', 'empty', isTeacher()
    ? 'עוד אין ילדים ברשימה. הוסיפו שמות בלשונית "הילדים" ⚙️'
    : 'המורה עוד לא הוסיפה ילדים ללוח.');
  td.colSpan = cols;
  tr.appendChild(td);
  table.appendChild(tr);
}

function renderBoard() {
  const table = $('boardTable');
  table.replaceChildren();
  if (!isTeacher()) editMode = false;
  $('editToggle').hidden = !isTeacher();
  $('editToggle').textContent = editMode ? '✅ סיום שינוי' : '✏️ שינוי שיבוץ';
  $('boardHint').textContent = editMode
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
  if (cls.children.length === 0) { emptyNotice(tbody, TASKS.length + 1); return; }

  const today = todayIndex();
  DAYS.forEach((dayName, i) => {
    const tr = el('tr', i === today ? 'today' : '');
    const th = el('th', 'day');
    th.appendChild(el('span', 'day-name', dayName));
    th.appendChild(el('span', 'day-date', shortDate(dayDate(cls.weekStart, i))));
    if (i === today) th.appendChild(el('span', 'today-badge', 'היום'));
    tr.appendChild(th);

    TASKS.forEach((t) => {
      const slot = slotOf(i, t.key);
      const child = childById(slot.childId);
      const td = el('td');
      if (editMode) {
        const sel = el('select', 'slot-select');
        sel.setAttribute('aria-label', `${t.label} ביום ${dayName}`);
        sel.appendChild(new Option('—', ''));
        cls.children.forEach((c) => sel.appendChild(new Option(c.name, c.id, false, c.id === slot.childId)));
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
  const table = $('kidsTable');
  table.replaceChildren();
  const today = todayIndex();

  const head = el('tr');
  head.appendChild(el('th', 'corner', 'שם'));
  DAYS.forEach((d, i) => {
    const th = el('th', i === today ? 'today-col' : '');
    th.appendChild(el('span', 'day-name', d));
    th.appendChild(el('span', 'day-date', shortDate(dayDate(cls.weekStart, i))));
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
  if (cls.children.length === 0) { emptyNotice(tbody, DAYS.length + 2); return; }

  cls.children.forEach((c) => {
    const tr = el('tr');
    tr.appendChild(el('th', 'kid-name', c.name));
    let weekMedals = 0;
    DAYS.forEach((_, i) => {
      const td = el('td', i === today ? 'today-col' : '');
      const chips = el('div', 'chips');
      TASKS.forEach((t) => {
        const slot = slotOf(i, t.key);
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
  const teacher = isTeacher();
  document.querySelectorAll('.teacher-only').forEach((e) => { e.hidden = !teacher; });
  document.querySelectorAll('.guest-only').forEach((e) => { e.hidden = teacher; });
  if (teacher) {
    $('classCode').textContent = formatCode(classId);
  }

  const list = $('childList');
  list.replaceChildren();
  if (cls.children.length === 0) {
    list.appendChild(el('li', 'empty', teacher ? 'הרשימה ריקה – כתבו שם ולחצו "הוספה".' : 'הרשימה ריקה.'));
    return;
  }
  cls.children.forEach((c) => {
    const li = el('li', 'child-row');
    li.appendChild(el('span', 'child-name', c.name));
    li.appendChild(el('span', 'child-medals', `🥇 ${medalsOf(c.id)}`));
    if (teacher) {
      const del = el('button', 'btn-icon', '🗑️');
      del.type = 'button';
      del.setAttribute('aria-label', `הסרת ${c.name}`);
      del.addEventListener('click', () => removeChild(c.id));
      li.appendChild(del);
    }
    list.appendChild(li);
  });
}

function render() {
  if (!cls) return;
  renderHeader();
  renderBoard();
  renderKids();
  renderManage();
}

/* ---------- tabs ---------- */

function showTab(name) {
  tabChosen = true;
  document.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
  store.set(TAB_KEY, name);
}

function chooseFirstTab() {
  const saved = store.get(TAB_KEY);
  if (isTeacher() && cls.children.length === 0) showTab('manage');
  else showTab(['board', 'kids', 'manage'].includes(saved) ? saved : 'board');
}

/* ---------- sound ---------- */

let audioCtx;
let soundOn = store.get(SOUND_KEY) !== 'off';

function bell(ctx, out, freq, start, length, volume) {
  // A soft bell: a sine tone plus quieter overtones, fading out.
  [[1, 1], [2, 0.25], [3, 0.08]].forEach(([mult, amp]) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq * mult;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume * amp, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
    osc.connect(gain).connect(out);
    osc.start(start);
    osc.stop(start + length + 0.05);
  });
}

// Cheerful "well done" jingle: a rising major arpeggio with a little sparkle.
function playSuccess() {
  if (!soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const ctx = audioCtx;
    const out = ctx.createGain();
    out.gain.value = 0.6;
    out.connect(ctx.destination);
    const t = ctx.currentTime + 0.02;
    [523.25, 659.25, 783.99].forEach((f, i) => bell(ctx, out, f, t + i * 0.1, 0.5, 0.35));
    bell(ctx, out, 1046.5, t + 0.3, 1.1, 0.4);
    bell(ctx, out, 1318.5, t + 0.3, 1.1, 0.15);
    [2093, 2637, 3136].forEach((f, i) => bell(ctx, out, f, t + 0.45 + i * 0.06, 0.35, 0.05));
  } catch (e) { /* audio unavailable */ }
}

function renderSoundToggle() {
  const btn = $('soundToggle');
  btn.textContent = soundOn ? '🔊' : '🔇';
  btn.setAttribute('aria-label', soundOn ? 'השתקת צלילים' : 'הפעלת צלילים');
  btn.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
}

/* ---------- overlays ---------- */

let celebrateTimer;
function celebrate(name) {
  const box = $('celebrate');
  $('celebrateText').textContent = `כל הכבוד, ${name}! קיבלת מדליית זהב`;
  box.hidden = false;
  box.classList.remove('show');
  void box.offsetWidth; // restart animation
  box.classList.add('show');
  clearTimeout(celebrateTimer);
  celebrateTimer = setTimeout(() => { box.hidden = true; }, 1800);
}

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

function showModal(text, { okOnly = false } = {}) {
  const modal = $('modal');
  const yes = $('modalYes');
  const no = $('modalNo');
  $('modalText').textContent = text;
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

function bindEvents() {
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = normalizeCode($('codeInput').value);
    if (code.length !== 8) {
      showWelcome('הקוד צריך להיות 8 תווים, למשל ABCD-1234.');
      return;
    }
    $('codeInput').value = '';
    openClass(code);
  });

  $('loginForm').addEventListener('submit', (e) => { e.preventDefault(); login(); });
  $('createForm').addEventListener('submit', (e) => { e.preventDefault(); create(); });
  $('showCreate').addEventListener('click', () => showWelcome('', 'create'));
  $('hideCreate').addEventListener('click', () => showWelcome('', 'login'));
  $('welcomeBack').addEventListener('click', () => { if (cls) { showScreen('app'); render(); } });

  $('addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    addChild($('nameInput').value);
    $('nameInput').value = '';
    $('nameInput').focus();
  });

  $('editToggle').addEventListener('click', () => {
    editMode = !editMode;
    renderBoard();
  });

  $('reshuffleBtn').addEventListener('click', async () => {
    if (cls.children.length === 0) return;
    const ok = await showModal('לשבץ מחדש את כל המשימות שעוד לא בוצעו השבוע?');
    if (!ok) return;
    write(updateDoc(classRef(), { assign: planAssign(cls.children, cls.assign, cls.done) }));
  });

  $('resetMedalsBtn').addEventListener('click', async () => {
    const ok = await showModal('לאפס את כל המדליות של כל הילדים?');
    if (!ok) return;
    write(updateDoc(classRef(), { medals: {} }));
  });

  $('shareBtn').addEventListener('click', shareLink);
  $('logoutBtn').addEventListener('click', async () => {
    const ok = await showModal('לצאת מחשבון המורה? הלוח יישאר במכשיר הזה לצפייה ולסימון משימות.');
    if (ok) await signOut(auth);
  });
  $('deleteAccountBtn').addEventListener('click', deleteAccount);
  $('teacherLoginBtn').addEventListener('click', () => showWelcome('', 'login'));
  $('leaveBtn').addEventListener('click', async () => {
    const ok = await showModal('להתנתק מהלוח במכשיר הזה? אפשר להצטרף שוב עם הקוד.');
    if (!ok) return;
    forgetClass();
    showWelcome();
  });

  renderSoundToggle();
  $('soundToggle').addEventListener('click', () => {
    soundOn = !soundOn;
    store.set(SOUND_KEY, soundOn ? 'on' : 'off');
    renderSoundToggle();
    playSuccess();
  });

  $('celebrate').addEventListener('click', (e) => { e.currentTarget.hidden = true; });

  // Start a new week / move "today" while the app stays open.
  let lastDay = todayIndex();
  const tick = () => {
    if (!cls) return;
    checkNewWeek();
    if (todayIndex() !== lastDay) { lastDay = todayIndex(); render(); }
  };
  setInterval(tick, 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}

function init() {
  bindEvents();

  // A shared link looks like .../?class=ABCD1234
  const params = new URLSearchParams(location.search);
  const linkCode = normalizeCode(params.get('class'));
  if (linkCode) {
    store.set(CLASS_KEY, linkCode);
    history.replaceState(null, '', location.pathname);
  }

  let first = true;
  onAuthStateChanged(auth, (u) => {
    const wasTeacher = isTeacher();
    user = u;
    if (first) {
      first = false;
      const saved = store.get(CLASS_KEY);
      if (saved) openClass(saved);
      else if (u && codeOfUser(u)) openClass(codeOfUser(u));
      else showWelcome();
      return;
    }
    if (cls && wasTeacher !== isTeacher()) render();
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:' && location.hostname !== 'localhost') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  if (useEmulator) window.__zoo = { get cls() { return cls; }, get classId() { return classId; }, planAssign, checkNewWeek };
}

init();
