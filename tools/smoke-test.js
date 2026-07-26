/* app.js 的執行期煙霧測試（開發用工具，網站本身不會用到這個檔案）。

   用途：語法檢查只能證明「檔案能被解析」，抓不到 TDZ（用到還沒初始化的
   const）、打錯的元素 id、呼叫不存在的函式這類「要真的跑起來才會爆」的錯。
   而 app.js 是一個 IIFE：只要載入時丟出任何例外，後面的事件綁定全都不會
   執行，結果就是「整個網站每個按鈕都沒反應」。這支就是為了擋住那種情況。

   做法：用 index.html 裡真實存在的 id 建一組假 DOM（app.js 若去拿一個
   HTML 裡沒有的 id 就會拿到 null 並炸掉），加上最小可用的 IndexedDB、
   localStorage 等瀏覽器 API，然後把 app.js 跑一遍，最後模擬點擊主要按鈕。

   執行（本機沒裝 Node，借 VS Code 內附的 Electron 當 Node 用）：
     $env:ELECTRON_RUN_AS_NODE = "1"
     & "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" tools/smoke-test.js .
   有裝 Node 的話直接： node tools/smoke-test.js .
   結束碼 0 = PASS。 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = process.argv[2] || 'c:\\劉弘廷\\電繪社';
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const code = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

const IDS = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const DATA_ORDER = [...html.matchAll(/data-order="([^"]+)"/g)].map(m => m[1]);
const DATA_SEC   = [...html.matchAll(/data-sec="([^"]+)"/g)].map(m => m[1]);

const errors = [];
const missing = new Set();

function makeEl(dataset = {}) {
  const el = {
    dataset, style: {}, options: [], children: [], _on: {},
    textContent: '', innerHTML: '', value: '', src: '',
    checked: false, hidden: false, disabled: false, loading: '', alt: '', title: '',
    width: 0, height: 0, href: '', download: '',
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      toggle(c, f) { const on = f === undefined ? !this._s.has(c) : !!f; on ? this._s.add(c) : this._s.delete(c); return on; },
      contains(c) { return this._s.has(c); },
    },
    addEventListener(t, fn) { (this._on[t] ||= []).push(fn); },
    removeEventListener(t, fn) { this._on[t] = (this._on[t] || []).filter(f => f !== fn); },
    appendChild(c) { this.children.push(c); return c; },
    prepend(c) { this.children.unshift(c); return c; },
    remove() {}, removeAttribute() {}, setAttribute() {}, focus() {}, select() {},
    click() { (this._on.click || []).forEach(fn => fn({ target: this, preventDefault() {} })); },
    querySelector: sel => query(sel),
    querySelectorAll: sel => queryAll(sel),
    getContext: () => ({ drawImage() {} }),
    toBlob: cb => cb({ size: 10, type: 'image/jpeg' }),
    requestFullscreen: () => Promise.resolve(),
    getBoundingClientRect: () => ({ width: 100, height: 100 }),
  };
  return el;
}

const registry = new Map();
function byId(id) {
  if (!IDS.has(id)) { missing.add(id); return null; }
  if (!registry.has(id)) registry.set(id, makeEl());
  return registry.get(id);
}

function query(sel) {
  const s = String(sel).trim();
  const m = /^#([\w-]+)$/.exec(s);
  if (m) return byId(m[1]);
  const m2 = /^#([\w-]+)\s/.exec(s);              // 例如 "#durBox .chip.active"
  if (m2 && !IDS.has(m2[1])) { missing.add(m2[1]); return null; }
  return makeEl();
}

function queryAll(sel) {
  const s = String(sel).trim();
  const m = /^#([\w-]+)\s/.exec(s);
  if (m && !IDS.has(m[1])) { missing.add(m[1]); return []; }
  if (s.startsWith('#orderBox')) return DATA_ORDER.map(o => makeEl({ order: o }));
  if (s.startsWith('#durBox'))   return DATA_SEC.map(v => makeEl({ sec: v }));
  return [];
}

/* --- 最小可用的 IndexedDB --- */
const stores = { categories: new Map(), images: new Map() };
const fire = (req, result) => { req.result = result; setTimeout(() => req.onsuccess && req.onsuccess({ target: req }), 0); return req; };
const fakeStore = name => ({
  get: k => fire({}, stores[name].get(k)),
  getAll: () => fire({}, [...stores[name].values()]),
  put: v => { stores[name].set(v.id, v); return fire({}, v.id); },
  delete: k => { stores[name].delete(k); return fire({}, undefined); },
  createIndex() {},
});
const indexedDB = {
  open() {
    const req = {};
    setTimeout(() => {
      const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => fakeStore('images'),
        transaction(names) {
          const t = { objectStore: n => fakeStore(n) };
          setTimeout(() => t.oncomplete && t.oncomplete(), 0);
          return t;
        },
      };
      req.result = db;
      req.onsuccess && req.onsuccess();
    }, 0);
    return req;
  },
};

const store = new Map();
const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, Map, Set, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, isNaN, parseInt, parseFloat,
  indexedDB,
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  },
  URL: Object.assign(class extends URL {}, { createObjectURL: () => 'blob:x', revokeObjectURL() {} }),
  Blob: class { constructor(p) { this.size = 1; this.type = 'application/json'; } },
  FileReader: class { readAsDataURL() { setTimeout(() => this.onload && this.onload(), 0); } },
  createImageBitmap: async () => ({ width: 1000, height: 800, close() {} }),
  fetch: async () => { throw new Error('no network in smoke test'); },
  requestAnimationFrame: fn => setTimeout(() => fn(1), 0),
  cancelAnimationFrame: () => {},
  performance: { now: () => 1 },
  navigator: { storage: { estimate: async () => ({ quota: 100, usage: 1 }) } },
  AudioContext: class { createOscillator() { return { connect: () => ({ connect() {} }), start() {}, stop() {}, frequency: {} }; }
                        createGain() { return { connect: () => ({ connect() {} }), gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
                        get currentTime() { return 0; } get destination() { return {}; } },
};
sandbox.addEventListener = () => {};
sandbox.removeEventListener = () => {};
sandbox.window = sandbox;
sandbox.document = {
  querySelector: query,
  querySelectorAll: queryAll,
  createElement: () => makeEl(),
  createDocumentFragment: () => makeEl(),
  addEventListener(t, fn) { (this._on ||= {})[t] = fn; },
  get fullscreenElement() { return null; },
  exitFullscreen: () => Promise.resolve(),
};

process.on('uncaughtException', e => errors.push('uncaught: ' + e.message + '\n' + (e.stack || '').split('\n')[1]));
process.on('unhandledRejection', e => errors.push('rejected: ' + (e && e.message)));

try {
  vm.runInNewContext(code, sandbox, { filename: 'app.js' });
} catch (e) {
  errors.push('載入時就爆了: ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 3).join('\n'));
}

/* 讓 init 的 await 有機會跑完，然後按幾個不需要使用者回應的按鈕 */
setTimeout(() => {
  const CLICK = ['btnSelectAll', 'btnClearSel', 'btnStart', 'btnGo', 'btnCancelPractice',
                 'pPause', 'pNext', 'pPrev', 'pGray', 'pFlip', 'pHide', 'pQuit',
                 'btnDoneClose', 'btnImportUrls', 'btnImportPin'];
  for (const id of CLICK) {
    const el = registry.get(id);
    if (!el) { errors.push(`按鈕 #${id} 從來沒被綁定事件（bind() 可能中途就中止了）`); continue; }
    if (!el._on.click) { errors.push(`#${id} 沒有 click handler`); continue; }
    try { el.click(); } catch (e) { errors.push(`點 #${id} 爆了: ${e.message}`); }
  }
  setTimeout(() => {
    console.log('--- 假 DOM 裡找不到的 id（app.js 有用、index.html 沒有）---');
    console.log(missing.size ? [...missing].map(x => '  #' + x).join('\n') : '  （無）');
    console.log('--- 錯誤 ---');
    console.log(errors.length ? errors.map(e => '  ' + e).join('\n') : '  （無）');
    console.log(errors.length || missing.size ? 'FAIL' : 'PASS');
    process.exit(errors.length || missing.size ? 1 : 0);
  }, 60);
}, 60);
