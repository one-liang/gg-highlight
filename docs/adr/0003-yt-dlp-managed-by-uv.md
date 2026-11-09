# 用程式自己管理的 yt-dlp 下載 YouTube 影片與聊天室重播

YouTube 連結要能下載成本機檔案，還要拿到聊天室重播與「最常重播」熱度，而且免費、在使用者自己的電腦上執行。yt-dlp 是唯一同時做到這三件事、又持續跟著 YouTube 改版更新的開源工具（2025-11 到 2026-10 的 13 個 stable 版裡 12 個有 YouTube 修正）。因此由 Nuxt 呼叫 yt-dlp 的命令列，yt-dlp 由程式自己裝在專案的 `tools/` 裡（`uv tool install "yt-dlp[default,deno]"`，`UV_TOOL_DIR`／`UV_TOOL_BIN_DIR` 指到 `tools/`），`start.mjs` 每天在伺服器啟動前檢查更新一次。

## Considered Options

- **winget 的 `yt-dlp.yt-dlp`**：官方 exe、可以 `-U` 自我更新，但它的安裝清單會另外裝 Deno 和第二份 ffmpeg（`yt-dlp.FFmpeg`），`-U` 換掉檔案後 winget 記的版本也會不一致。
- **用 uv 鎖定版本（跟著 app 發布）**：YouTube 改版時 yt-dlp 常要在幾天內更新，鎖定的版本在兩次 app 更新之間就會壞掉。
- **`uv tool run`／`uvx` 每次執行**：沒有固定位置、更新時機不明確；要更新就得每次連 PyPI。
- **nightly 版當預設**：yt-dlp 的 README 推薦一般使用者用 nightly，但 stable 對個人工具已經夠新，壞掉時再手動換 nightly（README 有指令）。
- **winget 安裝 Deno 當 JavaScript 執行環境**：yt-dlp 現在一定要有 JavaScript 執行環境才能解 YouTube 的驗證。`yt-dlp[deno]` 從 PyPI 直接把 Deno 裝進同一個環境、跟 yt-dlp 一起更新，yt-dlp 會自動找到它；另外一律加 `--js-runtimes node:<伺服器的 node>` 當備援（Node 22 以上可以用，使用者本來就有 Node）。
- **讀瀏覽器 Cookie 下載私人或會員影片**：Windows 上 Chrome 127 起的 App-Bound 加密 yt-dlp 解不開，用帳號 Cookie 也有被封的風險；第一版不支援，需要時再考慮匯入 `cookies.txt`。

## Consequences

- 影片檔偏好 H.264＋AAC、最高 1080p：瀏覽器直接播、不用轉預覽，輸出剪輯也不用解 AV1；檔案比 AV1／VP9 大約 2.5 倍，下載檔留到影片從影片庫移除為止。
- 聊天室重播用另一次 yt-dlp 執行下載：同一次執行時，聊天室下載出錯會讓整個影片下載失敗。yt-dlp 的聊天室下載不能續傳，每次重新開始前要刪掉 `.part`。
- 重播熱度來自 YouTube 網頁的內部資料（不是 yt-dlp 文件列出的欄位），只有觀看次數夠多的影片才有，隨時可能消失，所以一律當成可有可無的訊號。
- 錯誤只能從 yt-dlp 的英文訊息判斷（yt-dlp 強制 `hl=en`），用對照表換成中文；YouTube 改版、訊息改變時要更新對照表。
- 雲端開發環境下載不了 YouTube 影片（Google 拒絕資料中心的 IP，幾次讀取後也會要求「確認不是機器人」），測試一律用假的 yt-dlp；真的下載、續傳、剛結束的直播與各種錯誤訊息要在使用者的 Windows 電腦上確認。
