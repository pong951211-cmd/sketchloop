# SketchLoop · 速寫練習

上傳／匯入參考圖 → 分類 → 開計時器練習速寫。純前端，圖片存在瀏覽器本機（IndexedDB），可離線使用，也可一鍵部署上線。

## 功能

- **圖庫**：建立分類（站姿、手、動態…），上傳圖片（也可直接拖進視窗）、多選、移動、刪除、下載 JSON 備份。
- **匯入**：
  - 貼圖片直連網址（可多行批次）。
  - 貼 **Pinterest 公開看板連結**，批次抓取看板圖片。
- **計時練習**：
  - 每張時間：30 秒 / 1 / 2 / 5 / 10 分，或自訂秒數。
  - 結束條件：跑完全部 / 限定張數 / 倒數總時長。
  - 隨機順序、循環播放、灰階、換圖提示音。
  - 播放器：暫停、上一張/下一張、灰階、水平翻轉、隱藏介面、全螢幕進度條。
  - 鍵盤快捷鍵：`空白鍵` 暫停、`←/→` 換張、`G` 灰階、`F` 翻轉、`H` 隱藏介面、`Esc` 結束。

## 檔案結構

```
index.html        介面
styles.css        樣式
app.js            全部邏輯（IndexedDB 儲存、圖庫、播放器、匯入）
api/pinterest.js  抓取 Pinterest 看板的 serverless 函式（部署後啟用）
vercel.json       Vercel 設定
```

## 在自己電腦上先試用

因為用到 IndexedDB 與 fetch，直接雙擊 `index.html` 部分瀏覽器會擋。建議起一個本機伺服器：

```bash
# 在此資料夾內執行任一個
python3 -m http.server 8080
# 或
npx serve
```

然後開 `http://localhost:8080`。上傳圖片、計時練習都能用。
（Pinterest 看板匯入在本機會嘗試公共代理，成功率較低；部署到 Vercel 後最穩定。）

## 部署上線（推薦 Vercel，免費、含後端函式）

1. 把這個資料夾放到一個 GitHub repo。
2. 到 [vercel.com](https://vercel.com) → New Project → 匯入該 repo → Deploy（不需任何設定）。
3. 完成後會拿到網址，`api/pinterest.js` 會自動變成 `/api/pinterest`，Pinterest 看板匯入即可運作。

也可用 **Netlify**：把 `api/pinterest.js` 改放到 `netlify/functions/pinterest.js`，並把 `app.js` 內呼叫的路徑 `/api/pinterest` 改成 `/.netlify/functions/pinterest`。

純靜態託管（GitHub Pages 等）也能用，只是沒有後端，Pinterest 看板匯入會退回公共代理（較不穩定）；上傳與網址匯入不受影響。

## 說明與限制

- 圖片存在**這台裝置的這個瀏覽器**裡（IndexedDB），換裝置或清除瀏覽資料會不見。若要跨裝置同步、多人使用，需要再接雲端儲存與帳號系統（可後續擴充）。
- 部分網站的圖片有跨網域（CORS）限制，網址匯入可能失敗；Pinterest 透過後端函式抓取可避開此問題。
- 請尊重圖片版權，僅作個人練習用途。

## 之後可以加的功能

雲端同步與帳號、資料夾整包匯入、備份還原（目前只有匯出）、練習紀錄與統計、課程節奏預設（暖身短時→長時）、格線輔助。