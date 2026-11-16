'use strict';

const STORAGE_KEY = 'notes';
const SAVE_DELAY = 300;
const LOCALE = 'pt-BR';

// ---------- Armazenamento ----------
// Usa chrome.storage.local; fora da extensão (ex.: abrindo o HTML direto) cai para localStorage.
const storage = (() => {
  if (globalThis.chrome?.storage?.local) {
    return {
      get: async () => (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || [],
      set: (value) => chrome.storage.local.set({ [STORAGE_KEY]: value }),
      onExternalChange(callback) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'local' && changes[STORAGE_KEY]) callback(changes[STORAGE_KEY].newValue || []);
        });
      },
    };
  }
  return {
    get: async () => JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'),
    set: async (value) => localStorage.setItem(STORAGE_KEY, JSON.stringify(value)),
    onExternalChange(callback) {
      window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEY) callback(JSON.parse(e.newValue || '[]'));
      });
    },
  };
})();

// ---------- Estado ----------
let notes = [];
let currentId = null;
let query = '';
let saveTimer = null;
let toastTimer = null;
let lastDeleted = null;
const pendingWrites = new Set();

// ---------- Elementos ----------
const $ = (id) => document.getElementById(id);
const listView = $('list-view');
const editorView = $('editor-view');
const listScroll = $('list-scroll');
const editorScroll = $('editor-scroll');
const sectionsEl = $('sections');
const emptyEl = $('empty');
const searchEl = $('search');
const countEl = $('count');
const titleEl = $('title');
const bodyEl = $('body');
const dateEl = $('editor-date');
const statsEl = $('stats');
const pinBtn = $('pin-btn');
const toastEl = $('toast');

// ---------- Utilidades ----------
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

const normalize = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const DAY = 86400000;

function daysAgo(ts) {
  return Math.round((startOfDay(new Date()) - startOfDay(new Date(ts))) / DAY);
}

function shortDate(ts) {
  const d = new Date(ts);
  const days = daysAgo(ts);
  if (days <= 0) return d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'Ontem';
  if (days < 7) {
    const w = d.toLocaleDateString(LOCALE, { weekday: 'long' });
    return w.charAt(0).toUpperCase() + w.slice(1);
  }
  return d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function longDate(ts) {
  const d = new Date(ts);
  const date = d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });
  const time = d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  return `${date} às ${time}`;
}

function groupLabel(ts) {
  const days = daysAgo(ts);
  if (days <= 0) return 'Hoje';
  if (days === 1) return 'Ontem';
  if (days < 7) return 'Últimos 7 dias';
  if (days < 30) return 'Últimos 30 dias';
  const d = new Date(ts);
  const month = d.toLocaleDateString(LOCALE, { month: 'long' });
  const label = month.charAt(0).toUpperCase() + month.slice(1);
  return d.getFullYear() === new Date().getFullYear() ? label : `${label} de ${d.getFullYear()}`;
}

const isEmpty = (n) => !n.title.trim() && !n.body.trim();
const getNote = (id) => notes.find((n) => n.id === id);

function firstLine(text) {
  return text.split('\n').map((l) => l.trim()).find(Boolean) || '';
}

// ---------- Persistência ----------
function persistNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const snapshot = JSON.stringify(notes);
  pendingWrites.add(snapshot);
  return storage.set(JSON.parse(snapshot));
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, SAVE_DELAY);
}

function flush() {
  if (saveTimer) persistNow();
}

storage.onExternalChange((incoming) => {
  const json = JSON.stringify(incoming);
  if (pendingWrites.delete(json)) return; // eco da nossa própria gravação

  // Mudança vinda de outra janela: mantém a nota que está sendo editada aqui, se houver alteração pendente.
  const editing = currentId && saveTimer ? getNote(currentId) : null;
  notes = editing ? incoming.map((n) => (n.id === editing.id ? editing : n)) : incoming;

  if (currentId) {
    const note = getNote(currentId);
    if (!note) return showList();
    if (!editing && document.activeElement !== titleEl && document.activeElement !== bodyEl) fillEditor(note);
  } else {
    renderList();
  }
});

// ---------- Lista ----------
function renderList() {
  const q = normalize(query.trim());
  const visible = notes
    .filter((n) => !q || normalize(`${n.title}\n${n.body}`).includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const groups = new Map();
  for (const note of visible) {
    const label = note.pinned ? 'Fixadas' : groupLabel(note.updatedAt);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(note);
  }
  // "Fixadas" sempre primeiro
  const ordered = [...groups].sort(([a], [b]) => (b === 'Fixadas') - (a === 'Fixadas'));

  const fragment = document.createDocumentFragment();
  for (const [label, items] of ordered) {
    const section = document.createElement('section');
    section.className = 'section';

    const h = document.createElement('h2');
    h.className = 'section-title';
    h.textContent = label;

    const group = document.createElement('div');
    group.className = 'group';
    items.forEach((n) => group.append(noteRow(n)));

    section.append(h, group);
    fragment.append(section);
  }
  sectionsEl.replaceChildren(fragment);

  const total = notes.length;
  countEl.textContent = total === 0 ? '' : `${total} ${total === 1 ? 'nota' : 'notas'}`;

  emptyEl.hidden = visible.length > 0;
  if (!visible.length) {
    const searching = q && total;
    $('empty-title').textContent = searching ? 'Nenhum resultado' : 'Nenhuma nota';
    $('empty-text').textContent = searching
      ? `Nada encontrado para “${query.trim()}”.`
      : 'Crie sua primeira nota no botão abaixo.';
  }
}

function noteRow(note) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'note-row';
  row.addEventListener('click', () => openNote(note.id));

  const title = document.createElement('span');
  title.className = 'note-title';
  title.textContent = note.title.trim() || firstLine(note.body) || 'Nova nota';

  const meta = document.createElement('span');
  meta.className = 'note-meta';
  const date = document.createElement('span');
  date.className = 'note-date';
  date.textContent = shortDate(note.updatedAt);
  const preview = note.title.trim()
    ? firstLine(note.body)
    : firstLine(note.body.split('\n').slice(1).join('\n') || '');
  meta.append(date, preview || 'Nenhum texto adicional');

  row.append(title, meta);
  return row;
}

function showList() {
  flush();
  const note = getNote(currentId);
  if (note && isEmpty(note)) {
    notes = notes.filter((n) => n.id !== note.id);
    persistNow();
  }
  currentId = null;
  editorView.hidden = true;
  listView.hidden = false;
  renderList();
}

// ---------- Editor ----------
function fillEditor(note) {
  titleEl.value = note.title;
  bodyEl.value = note.body;
  pinBtn.setAttribute('aria-pressed', String(!!note.pinned));
  pinBtn.title = note.pinned ? 'Desafixar nota' : 'Fixar nota';
  updateMeta(note);
  autosize();
}

function updateMeta(note) {
  dateEl.textContent = longDate(note.updatedAt);
  const text = `${note.title} ${note.body}`.trim();
  const words = text ? text.split(/\s+/).length : 0;
  statsEl.textContent = words ? `${words} ${words === 1 ? 'palavra' : 'palavras'}` : '';
}

function openNote(id, { focus = 'body' } = {}) {
  const note = getNote(id);
  if (!note) return;
  currentId = id;
  listView.hidden = true;
  editorView.hidden = false;
  editorScroll.scrollTop = 0;
  fillEditor(note);
  const target = focus === 'title' ? titleEl : bodyEl;
  target.focus({ preventScroll: true });
  if (target === bodyEl) bodyEl.setSelectionRange(bodyEl.value.length, bodyEl.value.length);
  editorScroll.scrollTop = 0; // abre a nota sempre no topo
}

function createNote() {
  const now = Date.now();
  const note = { id: uid(), title: '', body: '', pinned: false, createdAt: now, updatedAt: now };
  notes.unshift(note);
  query = '';
  searchEl.value = '';
  openNote(note.id, { focus: 'title' });
}

function onEdit() {
  const note = getNote(currentId);
  if (!note) return;
  note.title = titleEl.value;
  note.body = bodyEl.value;
  note.updatedAt = Date.now();
  updateMeta(note);
  scheduleSave();
}

function autosize() {
  const top = editorScroll.scrollTop;
  bodyEl.style.height = 'auto';
  bodyEl.style.height = `${bodyEl.scrollHeight}px`;
  editorScroll.scrollTop = top; // evita "pulo" ao redimensionar
}

// Mantém o cursor visível ao digitar perto do fim da tela
function keepCaretVisible() {
  if (document.activeElement !== bodyEl) return;
  const style = getComputedStyle(bodyEl);
  const lineHeight = parseFloat(style.lineHeight) || 24;
  // Mede a altura do texto até o cursor com um elemento espelho invisível
  const mirror = keepCaretVisible.mirror || (keepCaretVisible.mirror = document.createElement('div'));
  Object.assign(mirror.style, {
    position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
    width: `${bodyEl.clientWidth}px`, font: style.font, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing,
  });
  mirror.textContent = bodyEl.value.slice(0, bodyEl.selectionEnd) + '​';
  document.body.append(mirror);
  const caretY = bodyEl.offsetTop + mirror.offsetHeight;
  mirror.remove();
  const viewTop = editorScroll.scrollTop;
  const viewBottom = viewTop + editorScroll.clientHeight;
  if (caretY + lineHeight > viewBottom) editorScroll.scrollTop = caretY + lineHeight * 2 - editorScroll.clientHeight;
  else if (caretY - lineHeight < viewTop) editorScroll.scrollTop = Math.max(0, caretY - lineHeight * 2);
}

function togglePin() {
  const note = getNote(currentId);
  if (!note) return;
  note.pinned = !note.pinned;
  pinBtn.setAttribute('aria-pressed', String(note.pinned));
  pinBtn.title = note.pinned ? 'Desafixar nota' : 'Fixar nota';
  persistNow();
}

function deleteNote() {
  const index = notes.findIndex((n) => n.id === currentId);
  if (index === -1) return;
  const [note] = notes.splice(index, 1);
  currentId = null;
  persistNow();
  showList();
  if (!isEmpty(note)) showToast({ note, index });
}

// ---------- Toast (desfazer) ----------
function showToast(deleted) {
  lastDeleted = deleted;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}

function hideToast() {
  toastEl.hidden = true;
  lastDeleted = null;
}

function undoDelete() {
  if (!lastDeleted) return;
  const { note, index } = lastDeleted;
  notes.splice(Math.min(index, notes.length), 0, note);
  persistNow();
  hideToast();
  renderList();
}

// ---------- Barras com borda ao rolar ----------
function watchScroll(scrollEl, bar) {
  scrollEl.addEventListener('scroll', () => {
    bar.classList.toggle('scrolled', scrollEl.scrollTop > (scrollEl === listScroll ? 34 : 4));
  }, { passive: true });
}

// ---------- Eventos ----------
$('new-btn').addEventListener('click', createNote);
$('back-btn').addEventListener('click', showList);
$('delete-btn').addEventListener('click', deleteNote);
$('undo-btn').addEventListener('click', undoDelete);
pinBtn.addEventListener('click', togglePin);

searchEl.addEventListener('input', () => {
  query = searchEl.value;
  renderList();
});

titleEl.addEventListener('input', onEdit);
bodyEl.addEventListener('input', () => { autosize(); keepCaretVisible(); onEdit(); });

// Recalcula a altura quando a largura do painel muda
new ResizeObserver(() => { if (currentId) autosize(); }).observe(editorScroll);

titleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || (e.key === 'ArrowDown' && titleEl.selectionStart === titleEl.value.length)) {
    e.preventDefault();
    bodyEl.focus();
    bodyEl.setSelectionRange(0, 0);
  }
});

bodyEl.addEventListener('keydown', (e) => {
  if (e.key === 'Backspace' && bodyEl.selectionStart === 0 && bodyEl.selectionEnd === 0) {
    e.preventDefault();
    titleEl.focus();
  }
});

// Clicar na área vazia do editor foca o texto
editorScroll.addEventListener('mousedown', (e) => {
  if (e.target === editorScroll) {
    e.preventDefault();
    bodyEl.focus();
    bodyEl.setSelectionRange(bodyEl.value.length, bodyEl.value.length);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && currentId) {
    e.preventDefault();
    showList();
  } else if (e.key === '/' && !currentId && document.activeElement !== searchEl) {
    e.preventDefault();
    searchEl.focus();
  } else if ((e.altKey && e.key.toLowerCase() === 'n' && !e.shiftKey) || (e.key === 'n' && !currentId && document.activeElement !== searchEl && !e.ctrlKey && !e.metaKey)) {
    e.preventDefault();
    if (currentId) showList();
    createNote();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
});
window.addEventListener('pagehide', flush);

watchScroll(listScroll, listView.querySelector('.bar'));
watchScroll(editorScroll, editorView.querySelector('.bar'));

// Atualiza datas relativas ("Hoje", "Ontem"...) de tempos em tempos
setInterval(() => { if (!currentId) renderList(); }, 60000);

// ---------- Início ----------
(async () => {
  notes = await storage.get();
  renderList();
})();
