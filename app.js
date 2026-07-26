/* SketchLoop · 速寫練習
   純前端：IndexedDB 儲存圖片、圖庫管理、匯入、計時播放器。 */
(() => {
'use strict';

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ============================ IndexedDB ============================ */

const DB_NAME = 'sketchloop';
const DB_VER  = 1;
let dbp = null;

function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('categories')) {
        db.createObjectStore('categories', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('images')) {
        const s = db.createObjectStore('images', { keyPath: 'id' });
        s.createIndex('catId', 'catId');
        s.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(stores, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort  = () => reject(t.error);
    const names = Array.isArray(stores) ? stores : [stores];
    out = fn(...names.map(n => t.objectStore(n)));
  });
}

const asReq = req => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror   = () => rej(req.error);
});

const dbAll     = store => tx(store, 'readonly', s => asReq(s.getAll())).then(p => p);
const dbGet     = (store, id) => tx(store, 'readonly', s => asReq(s.get(id))).then(p => p);
const dbPut     = (store, val) => tx(store, 'readwrite', s => { s.put(val); });
const dbDelete  = (store, id) => tx(store, 'readwrite', s => { s.delete(id); });

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ============================ 狀態 ============================ */

const state = {
  cats: [],            // {id, name, createdAt}
  images: [],          // 不含 blob 的清單 {id, catId, name, w, h, createdAt}
  thumbs: new Map(),   // id -> objectURL
  currentCat: 'all',
  selected: new Set(),
  settings: loadSettings(),
};

function loadSettings() {
  const d = { sec: 60, endMode: 'all', endCount: 10, endMinutes: 30,
              shuffle: true, loop: false, gray: false, sound: true, scope: [] };
  try { return Object.assign(d, JSON.parse(localStorage.getItem('sketchloop.settings') || '{}')); }
  catch { return d; }
}
function saveSettings() {
  localStorage.setItem('sketchloop.settings', JSON.stringify(state.settings));
}

function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

/** 自製的輸入／確認對話框。
    不用瀏覽器內建的 prompt()／confirm()，因為 VS Code Simple Browser、
    Electron 等內嵌瀏覽器會直接忽略 prompt()，按鈕看起來就像壞掉。
    傳 value（字串）＝輸入框模式，回傳字串或 null；不傳＝確認模式，回傳 true/false。 */
function ask({ title, msg = '', value = null, okText = '確定', danger = false }) {
  return new Promise(resolve => {
    const modal = $('#modalAsk'), input = $('#askInput'), ok = $('#askOk'), cancel = $('#askCancel');
    const hasInput = value !== null;

    $('#askTitle').textContent = title;
    $('#askMsg').textContent = msg;
    $('#askMsg').hidden = !msg;
    input.hidden = !hasInput;
    input.value = hasInput ? value : '';
    ok.textContent = okText;
    ok.classList.toggle('danger', danger);
    ok.classList.toggle('primary', !danger);
    modal.hidden = false;
    if (hasInput) setTimeout(() => { input.focus(); input.select(); }, 0);

    const done = v => {
      modal.hidden = true;
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      input.removeEventListener('keydown', onKey);
      ask._close = null;
      resolve(v);
    };
    const onOk = () => done(hasInput ? input.value.trim() : true);
    const onCancel = () => done(hasInput ? null : false);
    const onBackdrop = e => { if (e.target === modal) onCancel(); };
    const onKey = e => {
      if (e.key === 'Enter')  { e.preventDefault(); onOk(); }
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };

    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    input.addEventListener('keydown', onKey);
    ask._close = onCancel;            // 讓全域 Esc 也能取消
  });
}

/* ============================ 分類 ============================ */

async function loadAll() {
  state.cats = (await dbAll('categories')).sort((a, b) => a.createdAt - b.createdAt);
  const raw = await dbAll('images');
  raw.sort((a, b) => a.createdAt - b.createdAt);
  // 保留 thumb blob 以建立縮圖 URL，但不留住原圖 blob（省記憶體）
  for (const url of state.thumbs.values()) URL.revokeObjectURL(url);
  state.thumbs.clear();
  state.images = raw.map(r => {
    if (r.thumb) state.thumbs.set(r.id, URL.createObjectURL(r.thumb));
    return { id: r.id, catId: r.catId, name: r.name, w: r.w, h: r.h, createdAt: r.createdAt, size: r.size || 0 };
  });
}

function catName(id) {
  const c = state.cats.find(c => c.id === id);
  return c ? c.name : '未分類';
}

function imagesOf(catId) {
  if (catId === 'all') return state.images;
  if (catId === 'none') return state.images.filter(i => !i.catId || !state.cats.some(c => c.id === i.catId));
  return state.images.filter(i => i.catId === catId);
}

function renderCats() {
  const ul = $('#catList');
  ul.innerHTML = '';

  const add = (id, name, count, deletable) => {
    const li = document.createElement('li');
    li.className = id === state.currentCat ? 'active' : '';
    li.dataset.id = id;
    li.innerHTML =
      `<span class="name"></span><span class="count">${count}</span>` +
      (deletable ? `<button class="mini" data-act="rename" title="改名">✎</button>
                    <button class="mini" data-act="del" title="刪除分類">✕</button>` : '');
    li.querySelector('.name').textContent = name;
    li.addEventListener('click', e => {
      const act = e.target.dataset?.act;
      if (act === 'rename') return renameCat(id);
      if (act === 'del')    return deleteCat(id);
      state.currentCat = id;
      state.selected.clear();
      renderCats();
      renderGrid();
    });
    ul.appendChild(li);
  };

  add('all', '全部圖片', state.images.length, false);
  for (const c of state.cats) add(c.id, c.name, imagesOf(c.id).length, true);
  const orphan = imagesOf('none').length;
  if (orphan) add('none', '未分類', orphan, false);

  // 「移動到…」與匯入頁的分類下拉
  const opts = ['<option value="">未分類</option>']
    .concat(state.cats.map(c => `<option value="${c.id}"></option>`)).join('');
  for (const sel of [$('#urlTarget'), $('#pinTarget')]) {
    const keep = sel.value;
    sel.innerHTML = opts;
    state.cats.forEach((c, i) => { sel.options[i + 1].textContent = c.name; });
    sel.value = keep;
  }
  const mv = $('#moveTo');
  mv.innerHTML = '<option value="">移動到…</option><option value="__none">未分類</option>' +
                 state.cats.map(c => `<option value="${c.id}"></option>`).join('');
  state.cats.forEach((c, i) => { mv.options[i + 2].textContent = c.name; });
}

async function newCat() {
  const name = await ask({ title: '新增分類', msg: '例如：站姿、手、動態', value: '' });
  if (!name) return;
  const cat = { id: uid(), name, createdAt: Date.now() };
  await dbPut('categories', cat);
  state.cats.push(cat);
  state.currentCat = cat.id;
  renderCats(); renderGrid();
}

async function renameCat(id) {
  const c = state.cats.find(c => c.id === id);
  if (!c) return;
  const name = await ask({ title: '分類改名', value: c.name });
  if (!name) return;
  c.name = name;
  await dbPut('categories', c);
  renderCats(); renderGrid();
}

async function deleteCat(id) {
  const n = imagesOf(id).length;
  const yes = await ask({
    title: `刪除分類「${catName(id)}」？`,
    msg: `裡面的 ${n} 張圖片會變成「未分類」，不會被刪掉。`,
    okText: '刪除分類', danger: true,
  });
  if (!yes) return;
  const ids = imagesOf(id).map(i => i.id);
  await tx(['categories', 'images'], 'readwrite', async (cs, is) => {
    cs.delete(id);
    for (const iid of ids) {
      const r = is.get(iid);
      r.onsuccess = () => { const v = r.result; if (v) { v.catId = ''; is.put(v); } };
    }
  });
  state.cats = state.cats.filter(c => c.id !== id);
  state.images.forEach(i => { if (i.catId === id) i.catId = ''; });
  if (state.currentCat === id) state.currentCat = 'all';
  renderCats(); renderGrid();
}

/* ============================ 圖庫 ============================ */

function renderGrid() {
  const list = imagesOf(state.currentCat);
  $('#catTitle').textContent =
    state.currentCat === 'all' ? '全部圖片'
    : state.currentCat === 'none' ? '未分類'
    : catName(state.currentCat);

  const grid = $('#grid');
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const img of list) {
    const cell = document.createElement('div');
    cell.className = 'cell' + (state.selected.has(img.id) ? ' sel' : '');
    cell.dataset.id = img.id;
    const el = document.createElement('img');
    el.loading = 'lazy';
    el.src = state.thumbs.get(img.id) || '';
    el.alt = img.name || '';
    el.title = `${img.name || ''}${img.w ? `  ${img.w}×${img.h}` : ''}`;
    cell.appendChild(el);
    cell.addEventListener('click', () => toggleSelect(img.id));
    cell.addEventListener('dblclick', () => startPractice([img.id]));
    frag.appendChild(cell);
  }
  grid.appendChild(frag);
  $('#galleryEmpty').classList.toggle('show', list.length === 0);
  renderSelInfo();
  updateStorageInfo();
}

function toggleSelect(id) {
  state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
  $(`.cell[data-id="${id}"]`)?.classList.toggle('sel', state.selected.has(id));
  renderSelInfo();
}

function renderSelInfo() {
  const n = state.selected.size;
  $('#selInfo').textContent = n ? `已選取 ${n} 張（點「開始練習」只練這些）` : '';
  $('#btnDelete').disabled = n === 0;
  $('#moveTo').disabled = n === 0;
}

async function moveSelected(target) {
  const catId = target === '__none' ? '' : target;
  const ids = [...state.selected];
  await tx('images', 'readwrite', is => {
    for (const id of ids) {
      const r = is.get(id);
      r.onsuccess = () => { const v = r.result; if (v) { v.catId = catId; is.put(v); } };
    }
  });
  state.images.forEach(i => { if (state.selected.has(i.id)) i.catId = catId; });
  toast(`已移動 ${ids.length} 張到「${catId ? catName(catId) : '未分類'}」`);
  state.selected.clear();
  renderCats(); renderGrid();
}

async function deleteSelected() {
  const ids = [...state.selected];
  if (!ids.length) return;
  const yes = await ask({
    title: `刪除 ${ids.length} 張圖片？`,
    msg: '圖片會從這台電腦的瀏覽器裡永久移除，無法復原。',
    okText: '刪除', danger: true,
  });
  if (!yes) return;
  await tx('images', 'readwrite', is => { for (const id of ids) is.delete(id); });
  for (const id of ids) {
    const u = state.thumbs.get(id);
    if (u) URL.revokeObjectURL(u);
    state.thumbs.delete(id);
  }
  state.images = state.images.filter(i => !ids.includes(i.id));
  state.selected.clear();
  toast(`已刪除 ${ids.length} 張`);
  renderCats(); renderGrid();
}

async function updateStorageInfo() {
  const total = state.images.reduce((a, i) => a + (i.size || 0), 0);
  let txt = `${state.images.length} 張 · ${fmtBytes(total)}`;
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota) txt += ` / 可用約 ${fmtBytes(est.quota - est.usage)}`;
  } catch {}
  $('#storageInfo').textContent = txt;
}

function fmtBytes(b) {
  if (!b) return '0 MB';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i >= 2 ? 1 : 0)} ${u[i]}`;
}

/* ============================ 加入圖片 ============================ */

async function makeThumb(blob, max = 400) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const thumb = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.82));
    const out = { thumb: thumb || blob, w: bmp.width, h: bmp.height };
    bmp.close?.();
    return out;
  } catch {
    return { thumb: blob, w: 0, h: 0 };
  }
}

async function addImage(blob, { name = '', catId = '' } = {}) {
  if (!blob || !blob.size) throw new Error('空檔案');
  if (!/^image\//.test(blob.type || '')) {
    // 有些來源沒給 type，試著讓 createImageBitmap 驗證
    await createImageBitmap(blob).then(b => b.close?.());
  }
  const { thumb, w, h } = await makeThumb(blob);
  const rec = { id: uid(), catId, name, blob, thumb, w, h,
                size: blob.size + thumb.size, createdAt: Date.now() };
  await dbPut('images', rec);
  state.thumbs.set(rec.id, URL.createObjectURL(thumb));
  state.images.push({ id: rec.id, catId, name, w, h, createdAt: rec.createdAt, size: rec.size });
  return rec.id;
}

async function handleFiles(files) {
  const list = [...files].filter(f => /^image\//.test(f.type));
  if (!list.length) return;
  const catId = ['all', 'none'].includes(state.currentCat) ? '' : state.currentCat;
  let ok = 0, fail = 0;
  toast(`上傳中… 0/${list.length}`, 60000);
  for (const [i, f] of list.entries()) {
    try { await addImage(f, { name: f.name, catId }); ok++; }
    catch (e) { fail++; logImport(`✕ ${f.name}：${e.message}`, false); }
    toast(`上傳中… ${i + 1}/${list.length}`, 60000);
  }
  toast(`已加入 ${ok} 張${fail ? `，${fail} 張失敗` : ''}`);
  renderCats(); renderGrid();
}

/* ---------- 網址匯入 ---------- */

function proxied(url) {
  return [
    url,
    `https://images.weserv.nl/?url=${encodeURIComponent(url.replace(/^https?:\/\//, ''))}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  ];
}

async function fetchImageBlob(url) {
  let lastErr;
  for (const u of proxied(url)) {
    try {
      const r = await fetch(u, { mode: 'cors', referrerPolicy: 'no-referrer' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const b = await r.blob();
      if (!b.size) throw new Error('空回應');
      return b;
    } catch (e) { lastErr = e; }
  }
  throw new Error(lastErr?.message || '無法取得');
}

function logImport(line, ok = true) {
  const box = $('#importLog');
  if (box.dataset.fresh !== '1') { box.innerHTML = ''; box.dataset.fresh = '1'; }
  const div = document.createElement('div');
  div.className = ok ? 'ok' : 'err';
  div.textContent = line;
  box.prepend(div);
}

async function importUrls() {
  const urls = $('#urlList').value.split(/\s*\n\s*/).map(s => s.trim()).filter(Boolean);
  if (!urls.length) return toast('請先貼上圖片網址');
  const catId = $('#urlTarget').value;
  const btn = $('#btnImportUrls');
  btn.disabled = true;
  let ok = 0, fail = 0;
  for (const [i, url] of urls.entries()) {
    btn.textContent = `匯入中… ${i + 1}/${urls.length}`;
    try {
      const blob = await fetchImageBlob(url);
      await addImage(blob, { name: url.split('/').pop().slice(0, 60), catId });
      ok++; logImport(`✓ ${url}`);
    } catch (e) { fail++; logImport(`✕ ${url} — ${e.message}`, false); }
  }
  btn.disabled = false; btn.textContent = '開始匯入';
  if (ok) $('#urlList').value = '';
  toast(`匯入完成：成功 ${ok}${fail ? `，失敗 ${fail}` : ''}`);
  renderCats(); renderGrid();
}

/* ---------- Pinterest 看板匯入 ---------- */

async function fetchBoardImages(boardUrl, limit) {
  // 1) 後端函式（部署後可用）
  try {
    const r = await fetch(`/api/pinterest?url=${encodeURIComponent(boardUrl)}&limit=${limit}`);
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j.images) && j.images.length) return j.images;
      if (j.error) throw new Error(j.error);
    }
  } catch (e) { logImport(`後端函式不可用（${e.message}），改用公共代理…`, false); }

  // 2) 公共代理抓 HTML / RSS，再用正則抽 pinimg 連結
  const rss = boardUrl.replace(/\/+$/, '') + '.rss';
  const targets = [rss, boardUrl];
  const wrappers = [
    u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    u => `https://r.jina.ai/${u}`,
  ];
  for (const t of targets) {
    for (const w of wrappers) {
      try {
        const r = await fetch(w(t));
        if (!r.ok) continue;
        const html = await r.text();
        const found = extractPinimg(html, limit);
        if (found.length) return found;
      } catch {}
    }
  }
  throw new Error('抓不到看板內容（看板需為公開；本機代理成功率較低，部署後最穩定）');
}

function extractPinimg(html, limit) {
  const re = /https:\/\/i\.pinimg\.com\/[^"'\\\s)]+?\.(?:jpg|jpeg|png|webp)/gi;
  const seen = new Set(), out = [];
  for (const m of html.matchAll(re)) {
    const orig = m[0].replace(/\/(?:\d+x\d*|\d+x)\//, '/originals/');
    const key = orig.split('/').pop();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(orig);
    if (out.length >= limit) break;
  }
  return out;
}

async function importPinterest() {
  const url = $('#pinUrl').value.trim();
  if (!/^https?:\/\/([\w-]+\.)*(pinterest\.[a-z.]+|pin\.it)\//i.test(url)) {
    return toast('請貼 Pinterest 看板連結');
  }
  const limit = Math.max(1, Math.min(200, +$('#pinLimit').value || 40));
  const catId = $('#pinTarget').value;
  const btn = $('#btnImportPin');
  btn.disabled = true; btn.textContent = '抓取中…';
  try {
    const urls = await fetchBoardImages(url, limit);
    logImport(`找到 ${urls.length} 張圖片，開始下載…`);
    let ok = 0, fail = 0;
    for (const [i, u] of urls.entries()) {
      btn.textContent = `下載中… ${i + 1}/${urls.length}`;
      try {
        const blob = await fetchImageBlob(u);
        await addImage(blob, { name: u.split('/').pop().slice(0, 60), catId });
        ok++;
      } catch (e) { fail++; logImport(`✕ ${u} — ${e.message}`, false); }
    }
    logImport(`✓ 看板匯入完成：${ok} 張${fail ? `（失敗 ${fail}）` : ''}`);
    toast(`看板匯入完成：${ok} 張`);
    renderCats(); renderGrid();
  } catch (e) {
    logImport(`✕ ${e.message}`, false);
    toast('看板匯入失敗，詳見匯入紀錄');
  } finally {
    btn.disabled = false; btn.textContent = '抓取看板';
  }
}

/* ---------- 備份 ---------- */

async function exportBackup() {
  const rows = await dbAll('images');
  const toB64 = blob => new Promise(res => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.readAsDataURL(blob);
  });
  toast('打包中…', 60000);
  const images = [];
  for (const r of rows) {
    images.push({ id: r.id, catId: r.catId, name: r.name, w: r.w, h: r.h,
                  createdAt: r.createdAt, data: await toB64(r.blob) });
  }
  const json = JSON.stringify({ version: 1, exportedAt: Date.now(), categories: state.cats, images });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = `sketchloop-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('已下載備份檔');
}

/* ============================ 練習設定 ============================ */

/** 把已儲存的設定填回表單（開啟設定視窗、或啟動時同步一次）。 */
function fillForm() {
  const s = state.settings;
  // 練習範圍
  const box = $('#scopeBox');
  box.innerHTML = '';
  for (const c of state.cats) {
    const b = document.createElement('button');
    b.className = 'chip' + (s.scope.includes(c.id) ? ' active' : '');
    b.dataset.id = c.id;
    b.textContent = `${c.name} (${imagesOf(c.id).length})`;
    b.addEventListener('click', () => { b.classList.toggle('active'); updateHint(); });
    box.appendChild(b);
  }
  if (!state.cats.length) box.innerHTML = '<span class="muted">尚無分類，將使用全部圖片。</span>';

  // 每張時間
  $$('#durBox .chip').forEach(c => c.classList.toggle('active', +c.dataset.sec === s.sec));
  $('#durCustom').value = $$('#durBox .chip').some(c => +c.dataset.sec === s.sec) ? '' : s.sec;

  $(`input[name=endMode][value="${s.endMode}"]`).checked = true;
  $('#endCount').value   = s.endCount;
  $('#endMinutes').value = s.endMinutes;
  $('#optShuffle').checked = s.shuffle;
  $('#optLoop').checked    = s.loop;
  $('#optGray').checked    = s.gray;
  $('#optSound').checked   = s.sound;
}

function openPractice(forcedIds) {
  fillForm();
  openPractice._forced = forcedIds && forcedIds.length ? forcedIds.slice() : null;
  $('#modalPractice').hidden = false;
  updateHint();
}

function readForm() {
  const custom = +$('#durCustom').value;
  const activeChip = $('#durBox .chip.active');
  const sec = custom >= 3 ? Math.min(7200, Math.round(custom))
            : (activeChip ? +activeChip.dataset.sec : 60);
  return {
    sec,
    endMode:   $('input[name=endMode]:checked').value,
    endCount:  Math.max(1, +$('#endCount').value || 10),
    endMinutes:Math.max(1, +$('#endMinutes').value || 30),
    shuffle:   $('#optShuffle').checked,
    loop:      $('#optLoop').checked,
    gray:      $('#optGray').checked,
    sound:     $('#optSound').checked,
    scope:     $$('#scopeBox .chip.active').map(c => c.dataset.id),
  };
}

function poolFor(cfg, forced) {
  if (forced?.length) return forced.slice();
  if (cfg.scope.length) {
    return state.images.filter(i => cfg.scope.includes(i.catId)).map(i => i.id);
  }
  return state.images.map(i => i.id);
}

function updateHint() {
  const cfg = readForm();
  const pool = poolFor(cfg, openPractice._forced);
  let txt = `可用圖片 ${pool.length} 張 · 每張 ${fmtTime(cfg.sec)}`;
  if (cfg.endMode === 'all')   txt += ` · 預計總長 ${fmtTime(pool.length * cfg.sec)}`;
  if (cfg.endMode === 'count') txt += ` · 共 ${cfg.endCount} 張，約 ${fmtTime(cfg.endCount * cfg.sec)}`;
  if (cfg.endMode === 'time')  txt += ` · 倒數 ${cfg.endMinutes} 分（約 ${Math.floor(cfg.endMinutes * 60 / cfg.sec)} 張）`;
  $('#practiceHint').textContent = txt;
  $('#btnGo').disabled = pool.length === 0;
}

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? `${m}:${String(s).padStart(2, '0')}` : `${s} 秒`;
}

/* ============================ 播放器 ============================ */

const P = {
  active: false, cfg: null, pool: [], bag: [],
  played: [], idx: -1,
  urls: new Map(),          // imageId -> objectURL（僅保留少量）
  left: 0,                  // 這張剩餘秒數
  totalLeft: 0,             // 倒數總時長剩餘秒數
  paused: false, gray: false, flip: false, hideUI: false,
  raf: 0, last: 0, shown: 0, startedAt: 0,
};

function startPractice(forcedIds) {
  const cfg = readForm();
  Object.assign(state.settings, cfg);
  saveSettings();

  if (forcedIds && forcedIds.length) openPractice._forced = forcedIds.slice();
  const pool = poolFor(cfg, openPractice._forced);
  if (!pool.length) return toast('沒有可練習的圖片');

  $('#modalPractice').hidden = true;

  P.active = true; P.cfg = cfg; P.pool = pool; P.bag = [];
  P.played = []; P.idx = -1; P.shown = 0;
  P.left = cfg.sec;
  P.totalLeft = cfg.endMode === 'time' ? cfg.endMinutes * 60 : Infinity;
  P.paused = false; P.gray = cfg.gray; P.flip = false; P.hideUI = false;
  P.startedAt = Date.now();

  $('#player').hidden = false;
  applyStageClasses();
  $('#playerUI').classList.remove('hidden');
  togglePause(false);
  advance(1);
  P.last = performance.now();
  cancelAnimationFrame(P.raf);
  P.raf = requestAnimationFrame(tick);
}

function nextFromBag() {
  if (!P.cfg.shuffle) {
    const n = P.pool[P.shown % P.pool.length];
    return n;
  }
  if (!P.bag.length) {
    P.bag = P.pool.slice();
    for (let i = P.bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [P.bag[i], P.bag[j]] = [P.bag[j], P.bag[i]];
    }
  }
  return P.bag.pop();
}

function reachedEnd() {
  const c = P.cfg;
  if (c.endMode === 'count' && P.shown >= c.endCount) return true;
  if (c.endMode === 'time' && P.totalLeft <= 0) return true;
  if (c.endMode === 'all' && !c.loop && P.shown >= P.pool.length) return true;
  return false;
}

async function advance(dir, retry = 0) {
  if (!P.active) return;

  if (dir > 0) {
    if (reachedEnd()) return finish();
    if (P.idx + 1 < P.played.length) {
      P.idx++;                                  // 走回之前 prev 的歷史
    } else {
      if (P.cfg.endMode === 'all' && !P.cfg.loop && P.shown >= P.pool.length) return finish();
      P.played.push(nextFromBag());
      P.idx = P.played.length - 1;
    }
    P.shown++;
    if (P.cfg.sound) beep();
  } else {
    if (P.idx <= 0) return;
    P.idx--;
    P.shown = Math.max(1, P.shown - 1);
  }

  P.left = P.cfg.sec;
  await showCurrent(retry);
  updateHUD();
}

async function objectUrlFor(id) {
  if (P.urls.has(id)) return P.urls.get(id);
  const rec = await dbGet('images', id);
  if (!rec) return null;
  const url = URL.createObjectURL(rec.blob);
  P.urls.set(id, url);
  // 只留最近 6 張，避免記憶體堆積
  if (P.urls.size > 6) {
    const oldest = P.urls.keys().next().value;
    if (oldest !== id) { URL.revokeObjectURL(P.urls.get(oldest)); P.urls.delete(oldest); }
  }
  return url;
}

async function showCurrent(retry = 0) {
  const id = P.played[P.idx];
  const url = await objectUrlFor(id);
  if (!url) {                               // 圖片不見了（可能已被刪除）
    if (retry >= 5) return finish();
    P.played.splice(P.idx, 1);
    P.idx--; P.shown--;
    return advance(1, retry + 1);
  }
  $('#stageImg').src = url;
  // 預抓下一張
  const peek = P.played[P.idx + 1];
  if (peek) objectUrlFor(peek);
}

function updateHUD() {
  const c = P.cfg;
  const total = c.endMode === 'count' ? c.endCount
              : c.endMode === 'all'   ? P.pool.length : 0;
  $('#pCount').textContent = total ? `${P.shown} / ${total}` : `第 ${P.shown} 張`;
  $('#pClock').textContent = fmtClock(P.left);
  $('#pTotal').textContent = c.endMode === 'time' ? `總剩 ${fmtClock(P.totalLeft)}` : '';
  $('#progressFill').style.width = `${Math.max(0, Math.min(100, (1 - P.left / c.sec) * 100))}%`;
}

function fmtClock(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const m = Math.floor(sec / 60);
  return `${m}:${String(sec % 60).padStart(2, '0')}`;
}

function tick(now) {
  if (!P.active) return;
  const dt = Math.min(0.5, (now - P.last) / 1000);
  P.last = now;
  if (!P.paused) {
    P.left -= dt;
    if (P.cfg.endMode === 'time') P.totalLeft -= dt;
    if (P.cfg.endMode === 'time' && P.totalLeft <= 0) { finish(); return; }
    if (P.left <= 0) { advance(1); }
    updateHUD();
  }
  P.raf = requestAnimationFrame(tick);
}

function togglePause(force) {
  P.paused = force === undefined ? !P.paused : force;
  $('#pPause').textContent = P.paused ? '繼續' : '暫停';
  $('#pausedBadge').hidden = !P.paused;
}

function applyStageClasses() {
  const st = $('#stage');
  st.classList.toggle('gray', P.gray);
  st.classList.toggle('flip', P.flip);
  $('#pGray').classList.toggle('on', P.gray);
  $('#pFlip').classList.toggle('on', P.flip);
}

function finish() {
  if (!P.active) return;
  P.active = false;
  cancelAnimationFrame(P.raf);
  const mins = Math.round((Date.now() - P.startedAt) / 60000);
  quitPlayer();
  $('#doneText').textContent = `畫了 ${P.shown} 張，總共約 ${mins} 分鐘。辛苦了！`;
  $('#modalDone').hidden = false;
}

function quitPlayer() {
  P.active = false;
  cancelAnimationFrame(P.raf);
  for (const u of P.urls.values()) URL.revokeObjectURL(u);
  P.urls.clear();
  $('#stageImg').removeAttribute('src');
  $('#player').hidden = true;
  $('#pausedBadge').hidden = true;
  if (document.fullscreenElement) {
    try { Promise.resolve(document.exitFullscreen()).catch(() => {}); } catch {}
  }
}

/* 提示音 */
let actx = null;
function beep() {
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sine'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.12, actx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.18);
    o.connect(g).connect(actx.destination);
    o.start(); o.stop(actx.currentTime + 0.2);
  } catch {}
}

/* ============================ 事件綁定 ============================ */

function bind() {
  // 分頁
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    $$('.view').forEach(v => v.classList.remove('active'));
    $(`#view-${t.dataset.view}`).classList.add('active');
  }));

  $('#btnNewCat').addEventListener('click', newCat);
  $('#fileInput').addEventListener('change', e => { handleFiles(e.target.files); e.target.value = ''; });
  $('#btnSelectAll').addEventListener('click', () => {
    imagesOf(state.currentCat).forEach(i => state.selected.add(i.id));
    renderGrid();
  });
  $('#btnClearSel').addEventListener('click', () => { state.selected.clear(); renderGrid(); });
  $('#moveTo').addEventListener('change', e => {
    if (e.target.value) { moveSelected(e.target.value); e.target.value = ''; }
  });
  $('#btnDelete').addEventListener('click', deleteSelected);
  $('#btnExport').addEventListener('click', exportBackup);

  $('#btnImportUrls').addEventListener('click', importUrls);
  $('#btnImportPin').addEventListener('click', importPinterest);

  // 練習設定
  $('#btnStart').addEventListener('click', () => {
    if (!state.images.length) return toast('圖庫還是空的，先上傳或匯入圖片');
    openPractice(state.selected.size ? [...state.selected] : null);
  });
  $('#btnCancelPractice').addEventListener('click', () => { $('#modalPractice').hidden = true; });
  $('#modalPractice').addEventListener('click', e => {
    if (e.target.id === 'modalPractice') $('#modalPractice').hidden = true;
  });
  $$('#durBox .chip').forEach(c => c.addEventListener('click', () => {
    $$('#durBox .chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active');
    $('#durCustom').value = '';
    updateHint();
  }));
  $('#durCustom').addEventListener('input', () => {
    if (+$('#durCustom').value >= 3) $$('#durBox .chip').forEach(x => x.classList.remove('active'));
    updateHint();
  });
  ['#endCount', '#endMinutes'].forEach(s => $(s).addEventListener('input', updateHint));
  $$('input[name=endMode]').forEach(r => r.addEventListener('change', updateHint));
  $('#btnGo').addEventListener('click', () => startPractice());

  // 播放器
  $('#pPause').addEventListener('click', () => togglePause());
  $('#pPrev').addEventListener('click', () => advance(-1));
  $('#pNext').addEventListener('click', () => advance(1));
  $('#pGray').addEventListener('click', () => { P.gray = !P.gray; applyStageClasses(); });
  $('#pFlip').addEventListener('click', () => { P.flip = !P.flip; applyStageClasses(); });
  $('#pHide').addEventListener('click', toggleUI);
  $('#pQuit').addEventListener('click', quitPlayer);
  $('#pFull').addEventListener('click', toggleFullscreen);
  $('#stage').addEventListener('click', () => togglePause());

  $('#btnDoneClose').addEventListener('click', () => { $('#modalDone').hidden = true; });
  $('#btnDoneAgain').addEventListener('click', () => {
    $('#modalDone').hidden = true;
    openPractice(openPractice._forced);
  });

  // 快捷鍵
  document.addEventListener('keydown', e => {
    if (!$('#player').hidden) {
      const k = e.key.toLowerCase();
      if (e.code === 'Space') { e.preventDefault(); togglePause(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); advance(1); }
      else if (e.key === 'ArrowLeft')  { e.preventDefault(); advance(-1); }
      else if (k === 'g') { P.gray = !P.gray; applyStageClasses(); }
      else if (k === 'f') { P.flip = !P.flip; applyStageClasses(); }
      else if (k === 'h') { toggleUI(); }
      else if (e.key === 'Escape') { quitPlayer(); }
      return;
    }
    if (e.key === 'Escape') {
      if (ask._close) return ask._close();      // 輸入／確認框優先
      $('#modalPractice').hidden = true;
      $('#modalDone').hidden = true;
    }
  });

  // 阻止拖曳圖片離開頁面時的預設行為，並支援拖進來上傳
  window.addEventListener('dragover', e => { e.preventDefault(); });
  window.addEventListener('drop', e => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  });
}

function toggleUI() {
  P.hideUI = !P.hideUI;
  $('#playerUI').classList.toggle('hidden', P.hideUI);
}

function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      const el = $('#player');
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (!req) return toast('這個瀏覽器不支援全螢幕');
      Promise.resolve(req.call(el)).catch(() => toast('無法進入全螢幕'));
    }
  } catch { toast('無法切換全螢幕'); }
}

/* ============================ 啟動 ============================ */

(async function init() {
  bind();
  try {
    await loadAll();
  } catch (e) {
    toast('無法開啟本機資料庫：' + e.message, 6000);
  }
  renderCats();
  renderGrid();
  fillForm();   // 讓「雙擊圖片直接練習」也能用上次儲存的設定
})();

})();
