/* Serverless function：抓取 Pinterest 公開看板的圖片連結。
   GET /api/pinterest?url=<看板連結>&limit=40
   成功：{ ok:true, source:'rss', count, total, images:[...] }
   失敗：{ ok:false, error, tried:[...] }   tried 會列出試過的網址與回應碼

   為什麼只用 RSS：
   看板的網頁（HTML）裡除了看板本身的釘圖，還混雜使用者頭像、Pinterest 的
   介面圖示、以及「你可能也喜歡」的推薦圖，從外面無法分辨哪張是看板內容 ——
   早期版本直接掃整頁的 i.pinimg.com 連結，結果抓進大量無關圖片。
   看板 RSS（<看板網址>.rss）則是一個 <item> 對應一張真正的釘圖。
   代價是 Pinterest 只提供最新 20~25 筆，抓不到整個大看板。 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const PINIMG_RE = /https:\/\/i\.pinimg\.com\/[^"'\s<>)]+?\.(?:jpg|jpeg|png|webp)/i;

const HEADERS = {
  'user-agent': UA,
  'accept-language': 'zh-TW,zh;q=0.9,en;q=0.8',
};

function unescapeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
          .replace(/&amp;/g, '&');
}

/** 從 RSS 的每個 <item> 各取一張圖，並把縮圖尺寸換成原圖。 */
function pinsFromRss(xml, limit) {
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  const seen = new Set();
  const images = [];
  for (const item of items) {
    const m = PINIMG_RE.exec(unescapeXml(item));
    if (!m) continue;
    const url = m[0].replace(/\/(?:\d+x\d*|\d+x\d+_RS)\//, '/originals/');
    const key = url.slice(url.lastIndexOf('/') + 1);
    if (seen.has(key)) continue;
    seen.add(key);
    if (images.length < limit) images.push(url);
  }
  return { images, total: items.length };
}

/** pin.it 短連結 → 展開成真正的 pinterest.com 網址。 */
async function expandShortLink(url) {
  const r = await fetch(url, { redirect: 'follow', headers: HEADERS });
  return new URL(r.url || url);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const q = req.query || {};
  const raw = Array.isArray(q.url) ? q.url[0] : q.url;
  const limit = Math.max(1, Math.min(200, parseInt(q.limit, 10) || 40));
  const bad = (code, error, extra = {}) => res.status(code).json({ ok: false, error, ...extra });

  let board;
  try {
    board = new URL(String(raw || '').trim());
  } catch {
    return bad(400, '缺少或不合法的 url 參數');
  }
  if (!/^https?:$/.test(board.protocol)) return bad(400, '網址必須是 http/https');

  // App 分享出來的短連結先展開
  if (/(^|\.)pin\.it$/i.test(board.hostname)) {
    try { board = await expandShortLink(board.href); }
    catch (e) { return bad(502, `展不開這個 pin.it 短連結：${e.message}`); }
  }
  if (!/(^|\.)pinterest\.[a-z.]+$/i.test(board.hostname)) {
    return bad(400, `這不是 Pinterest 的網址（${board.hostname}）`);
  }

  const parts = board.pathname.split('/').filter(Boolean);
  if (parts[0] === 'pin') {
    return bad(400, '這是「單張釘圖」的網址。請改貼看板頁的網址：先在 Pinterest 打開那個看板，再複製上方網址列的連結。');
  }
  if (parts.length < 2) {
    return bad(400, '這是個人首頁的網址，不是看板。請打開某個看板後再複製網址（格式：pinterest.com/使用者/看板名/）。');
  }
  // 看板分區（.../看板/分區/）一律當成母看板處理
  const boardPath = parts.slice(0, 2).join('/');

  // 依序嘗試：原本的網域，以及 www.pinterest.com（有些國別網域的 RSS 會失效）
  const hosts = [board.host];
  if (!/^www\.pinterest\.com$/i.test(board.host)) hosts.push('www.pinterest.com');

  const tried = [];
  let xml = null;
  for (const host of hosts) {
    const rssUrl = `https://${host}/${boardPath}.rss`;
    try {
      const r = await fetch(rssUrl, {
        redirect: 'follow',
        headers: { ...HEADERS, accept: 'application/rss+xml,application/xml,text/xml' },
      });
      const ctype = r.headers.get('content-type') || '';
      const body = r.ok ? await r.text() : '';
      const isXml = /xml/i.test(ctype) || body.trimStart().startsWith('<?xml');
      tried.push(`${rssUrl} → HTTP ${r.status}${r.ok ? (isXml ? '（XML）' : `（不是 XML：${ctype || '未知'}）`) : ''}`);
      if (r.ok && isXml) { xml = body; break; }
    } catch (e) {
      tried.push(`${rssUrl} → 連線失敗：${e.message}`);
    }
  }

  if (!xml) {
    return bad(404,
      '拿不到這個看板的 RSS。可能原因：① 看板不是公開的（私人／密友看板不行，' +
      '而且「公開」要看看板本身的設定，不只是帳號）② 網址不是看板頁 ③ Pinterest 對這個看板沒有提供 RSS。',
      { tried });
  }

  const { images, total } = pinsFromRss(xml, limit);
  if (!images.length) {
    return bad(404, '這個看板的 RSS 裡沒有圖片（可能是空看板）。', { tried });
  }

  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
  return res.status(200).json({ ok: true, source: 'rss', count: images.length, total, images });
};
