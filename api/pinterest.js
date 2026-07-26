/* Serverless function：抓取 Pinterest 公開看板的圖片連結。
   部署到 Vercel 後可用：GET /api/pinterest?url=<看板連結>&limit=40
   回傳：{ ok, source, count, images: [imageUrl, ...] }

   在伺服器端抓取可避開瀏覽器的 CORS 限制，成功率比公共代理高很多。 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const PINIMG_RE = /https:\/\/i\.pinimg\.com\/[^"'\\\s<>)]+?\.(?:jpg|jpeg|png|webp)/gi;

/** 把 236x / 474x / 736x 這類縮圖尺寸換成原圖，並去重。 */
function collect(text, limit, out, seen) {
  for (const m of text.matchAll(PINIMG_RE)) {
    let url = m[0].replace(/\/(?:\d+x\d*|\d+x)\//, '/originals/');
    // 忽略頭像、看板封面拼貼等雜圖
    if (/\/(?:avatars|user_)/i.test(url)) continue;
    const key = url.slice(url.lastIndexOf('/') + 1);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
    if (out.length >= limit) return out;
  }
  return out;
}

async function get(url, accept) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': UA,
      'accept': accept,
      'accept-language': 'zh-TW,zh;q=0.9,en;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`上游回應 HTTP ${res.status}`);
  return res.text();
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
  const allowedHost = /(^|\.)pinterest\.[a-z.]+$/i.test(host) || /(^|\.)pin\.it$/i.test(host);
  if (!/^https?:$/.test(board.protocol) || !allowedHost) {
    return res.status(400).json({ ok: false, error: '只支援 pinterest.* 或 pin.it 連結' });
  }

  const clean = board.origin + board.pathname.replace(/\/+$/, '');
  const attempts = [
    { source: 'rss',  url: `${clean}.rss`, accept: 'application/rss+xml,application/xml,text/xml,*/*' },
    { source: 'html', url: `${clean}/`,    accept: 'text/html,application/xhtml+xml,*/*' },
  ];

  const images = [];
  const seen = new Set();
  const errors = [];
  let source = null;

  for (const a of attempts) {
    if (images.length >= limit) break;
    try {
      const body = await get(a.url, a.accept);
      const before = images.length;
      collect(body, limit, images, seen);
      if (images.length > before) source = source || a.source;
    } catch (e) {
      errors.push(`${a.source}: ${e.message}`);
    }
  }

  if (!images.length) {
    return res.status(502).json({
      ok: false,
      error: '抓不到圖片。請確認看板是公開的（Pinterest 有時也會擋機房 IP）。',
      details: errors,
    });
  }

  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
  return res.status(200).json({ ok: true, source, count: images.length, images });
};
