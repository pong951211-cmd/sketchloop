/* Serverless function：抓取 Pinterest 公開看板的圖片連結。
   部署到 Vercel 後可用：GET /api/pinterest?url=<看板連結>&limit=40
   回傳：{ ok, source, count, total, images: [imageUrl, ...] }

   為什麼只用 RSS：
   看板的網頁（HTML）裡除了看板本身的釘圖，還混雜了使用者頭像、Pinterest
   的介面圖示、以及「你可能也喜歡」的推薦圖，從外面看無法分辨哪張才是看板
   內容 —— 早期版本直接掃整頁的 i.pinimg.com 連結，結果抓進大量無關圖片。
   看板的 RSS（<看板網址>.rss）則是一個 <item> 對應一張真正的釘圖，精確得多。
   代價是 Pinterest 的 RSS 只給最新的 20~25 張，所以抓不到整個大看板。 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const PINIMG_RE = /https:\/\/i\.pinimg\.com\/[^"'\s<>)]+?\.(?:jpg|jpeg|png|webp)/i;

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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const q = req.query || {};
  const raw = Array.isArray(q.url) ? q.url[0] : q.url;
  const limit = Math.max(1, Math.min(200, parseInt(q.limit, 10) || 40));

  let board;
  try {
    board = new URL(String(raw || ''));
  } catch {
    return res.status(400).json({ ok: false, error: '缺少或不合法的 url 參數' });
  }
  const host = board.hostname;
  if (!/^https?:$/.test(board.protocol) || !/(^|\.)pinterest\.[a-z.]+$/i.test(host)) {
    return res.status(400).json({ ok: false, error: '請提供 pinterest.* 的看板連結' });
  }
  // 看板路徑必須是 /使用者/看板/
  const parts = board.pathname.split('/').filter(Boolean);
  if (parts.length < 2) {
    return res.status(400).json({
      ok: false,
      error: '這看起來不是看板連結。正確格式：https://www.pinterest.com/使用者/看板名/',
    });
  }

  const rssUrl = `${board.origin}/${parts.slice(0, 2).join('/')}.rss`;

  const notFound = {
    ok: false,
    error: '找不到這個看板。請確認：① 看板是公開的（不是私人或密友看板）② 連結是看板頁，不是單張釘圖或個人首頁 ③ 網址沒有打錯。',
    rssUrl,
  };

  let body, ctype;
  try {
    const r = await fetch(rssUrl, {
      redirect: 'follow',
      headers: { 'user-agent': UA, 'accept': 'application/rss+xml,application/xml,text/xml' },
    });
    if (r.status === 404 || r.status === 403) return res.status(404).json(notFound);
    ctype = r.headers.get('content-type') || '';
    body = await r.text();
    if (!r.ok) throw new Error(`Pinterest 回應 HTTP ${r.status}`);
  } catch (e) {
    return res.status(502).json({ ok: false, error: `連不到 Pinterest：${e.message}`, rssUrl });
  }

  // 關鍵驗證：拿到的必須真的是 RSS。看板不存在或不公開時，Pinterest 會回一頁
  // HTML，若不檢查就會把那頁上的圖示、推薦圖當成看板內容抓回去。
  const isXml = /xml/i.test(ctype) || body.trimStart().startsWith('<?xml');
  if (!isXml) return res.status(404).json(notFound);

  const { images, total } = pinsFromRss(body, limit);
  if (!images.length) {
    return res.status(404).json({ ok: false, error: '這個看板的 RSS 裡沒有圖片（可能是空看板）。', rssUrl });
  }

  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
  return res.status(200).json({ ok: true, source: 'rss', count: images.length, total, images });
};
