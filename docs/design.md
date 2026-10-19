# gg-highlight 設計

這份文件記錄設計討論（grilling）的共識，以及程式的模組分工。用語以 `GLOSSARY.md` 為準，架構決定見 `docs/adr/`。

## 產品行為

### 範圍與原則

- 個人自用，跑在使用者自己的 Windows 電腦（RTX 3060 Ti 8GB、32GB RAM），瀏覽器開 `http://127.0.0.1:3939`；只接受本機連線，沒有帳號。
- 全部用免費、可本機執行的工具：ffmpeg、faster-whisper（Python）、Ollama（里程碑 2）、yt-dlp（里程碑 3）。
- 介面全部繁體中文；程式碼用英文命名，對應 GLOSSARY 的英文名稱。

### 里程碑

1. **字幕剪輯**：本機影片 → 逐字稿（可編輯）→ 手動新增精華片段 → 用三種版型輸出帶字幕的剪輯。
2. **自動找精華**：音量與逐字稿（本機 LLM）兩種訊號、候選精華片段、精華分數與精華理由。
3. **YouTube**：連結下載、聊天室密度、重播熱度。

### 加入影片

- **影片資料夾**：設定頁指定一或多個資料夾（例如 OBS 錄影資料夾），系統列出其中的影片檔（不遞迴），挑選後直接引用原檔，不複製。
- **拖拉上傳**：檔案串流寫入 `data/uploads/`（會佔一份空間）。上傳後先 probe，再選語言與音軌。
- 加入時選 **語言**（`zh` 中文含中英夾雜／`en` 英文）與 **分析用音軌**（預設 0）。系統用 ffprobe 列出音軌讓使用者選。
- 同一個檔案路徑不能重複加入影片庫。

### 分析（Analysis）

- 背景執行、一次一支（顯示卡只有一張），其他排隊；可以關掉頁面。
- 每支原始影片只分析一次。失敗可以重試；程式中途被關掉，下次啟動時正在跑的分析從頭重跑。
- 里程碑 1 的步驟與進度權重：`probe`（2%）→ `extract-audio`（8%）→ `transcribe`（75%）→ `prepare-preview`（15%）。
  - `extract-audio`：取「分析用音軌」轉成 16kHz 單聲道 WAV，放在 `data/videos/<id>/audio.wav`，分析結束後刪除。
  - `transcribe`：中文用 Breeze-ASR-25（`SoybeanMilk/faster-whisper-Breeze-ASR-25`），英文用 Whisper large-v3-turbo（`deepdml/faster-whisper-large-v3-turbo-ct2`）。原始結果存 `data/videos/<id>/transcript.raw.json`，再切成字幕大小的逐字稿段落存進資料庫。中文一律經 OpenCC `cn → twp` 轉成台灣正體。
  - `prepare-preview`：瀏覽器能直接播的檔案（mp4/mov + h264/av1/vp9 + aac/mp3/opus）不另外處理；只有容器不對（例如 OBS 的 mkv）就 remux 成 `data/videos/<id>/preview.mp4`；編碼也不支援才轉成 720p h264。預覽一律用音軌 0。

### 音軌規則

- **分析用音軌**（使用者選）只用在語音辨識與訊號偵測。
- **預覽與剪輯**一律用 **音軌 0**：OBS 的音軌 1（ffmpeg 的 `0:a:0`）是全部混音，剪輯要有遊戲聲音與人聲。

### 逐字稿

- 每支原始影片一份，是所有字幕的唯一來源。
- 段落大小：最多約 2 行（中文 26 字、英文約 52 字元），最長約 7 秒，優先在標點與停頓處切開。
- 使用者可以改每段的文字（不能改時間點）；改完後新輸出的剪輯就會用新文字，已輸出的剪輯不變。

### 精華片段

- 狀態：`candidate`（候選）／`selected`（選用）／`dismissed`（捨棄）。
- 來源：`analysis`（里程碑 2 起由分析產生）／`manual`（使用者手動新增，一開始就是選用）。
- 使用者可以調整起訖點、切換狀態；手動片段不限長度，超過 180 秒顯示「可能無法上傳成 Shorts/Reels」提醒。
- （里程碑 2）分析產生的候選：長度 15–60 秒、對齊句子邊界且前後各留約 1 秒、重疊的合併、依精華分數排序、每小時影片最多約 10 個、缺少的訊號不扣分。

### 輸出剪輯

- 對一個精華片段按「輸出」：選版型（預設模糊背景）與是否燒錄字幕（預設是）。每次輸出都是一支新剪輯，記下當下的起訖點；之後改精華片段或逐字稿都不影響已輸出的剪輯。
- 版型：
  - `blurred-background`：1080×1920，原畫面等比縮到寬 1080 置中，背景是放大裁切後模糊的同一畫面。
  - `center-crop`：1080×1920，從原畫面中央裁出 9:16 再縮放。
  - `original`：維持原比例與解析度，最高 1080p（寬高取偶數）。
- 影格率維持原樣；能用 NVENC 就用 `h264_nvenc`，否則 `libx264`；音訊為音軌 0 轉 AAC；`+faststart`。
- 字幕：ASS 檔燒錄，字型 Noto Sans CJK TC（`fonts/` 資料夾），大字、白字黑邊、置中偏下、最多兩行。同時一定輸出對應的 `.srt`（時間以剪輯開頭為 0）。
- 輸出排隊、一次一支，和分析的佇列互相獨立。

### 從影片庫移除

- 確認後刪除：資料庫裡的影片、逐字稿、精華片段、剪輯紀錄；`data/videos/<id>/`、`data/clips/<id>/`；上傳複本或 YouTube 下載檔。
- **絕不刪除**影片資料夾裡的原始錄影檔。任何刪除都只限 `data/` 之內的路徑。
- 正在分析或輸出的工作會先被中止。

## 程式架構

Nuxt 4（`ssr: false` 的 SPA + Nitro server）負責介面、API、SQLite、佇列，以及呼叫 ffmpeg／Python 轉錄程式；Python 只有 `transcriber/` 這支 CLI（ADR-0001）。

```
app/                     Nuxt 前端（Vue 3 + Nuxt UI 4 + Tailwind 4）
server/api/              Nitro API routes（薄層：驗證輸入 → 呼叫 server/lib）
server/plugins/          啟動：開資料庫、復原中斷的工作、啟動佇列
server/lib/config.ts     路徑與環境變數設定
server/lib/subtitles/    逐字稿切段、OpenCC、換行、ASS/SRT（純函式）
server/lib/media/        ffprobe/ffmpeg：probe、抽音訊、預覽、輸出剪輯、NVENC 偵測
server/lib/transcription/ 呼叫 Python CLI、解析 JSON lines 協定
server/lib/db/           node:sqlite、schema、repositories
server/lib/library/      影片資料夾、上傳、移除時可刪的檔案
server/lib/http/         Range 檔案傳輸
server/lib/jobs/         分析佇列、輸出佇列
server/lib/services.ts   把上面組起來的單例（給 API routes 用）
shared/types/domain.ts   前後端共用型別
transcriber/             Python（uv 管理）：gg-transcribe CLI
scripts/                 start.mjs、doctor.mjs、fetch-fonts.mjs、setup.ps1
tests/                   測試素材產生器、整合測試、e2e
```

`server/lib/**` 一律用明確的 `import`（不依賴 Nitro auto-import），才能直接用 Vitest 測試。

### 資料夾 `data/`

```
data/gg-highlight.db          SQLite
data/videos/<videoId>/        audio.wav（分析中）、transcript.raw.json、preview.mp4
data/clips/<videoId>/         <clipId>.mp4、<clipId>.srt、<clipId>.ass
data/uploads/<uploadId>.<ext> 拖拉上傳的複本
data/downloads/<videoId>.<ext> YouTube 下載（里程碑 3）
```

### 環境變數

| 變數 | 預設 | 用途 |
| --- | --- | --- |
| `GG_DATA_DIR` | `data` | 資料夾 |
| `GG_FONTS_DIR` | `fonts` | 字幕字型資料夾 |
| `GG_FFMPEG` / `GG_FFPROBE` | `ffmpeg` / `ffprobe` | 執行檔路徑 |
| `GG_TRANSCRIBER_CMD` | `uv run --project transcriber gg-transcribe` | 轉錄 CLI 前綴（可用 JSON 陣列） |
| `GG_ASR_MODEL_ZH` / `GG_ASR_MODEL_EN` | Breeze / large-v3-turbo | 模型（測試用 `Systran/faster-whisper-tiny`） |
| `GG_ASR_DEVICE` | `auto` | `auto`／`cuda`／`cpu` |
| `GG_VIDEO_ENCODER` | 自動偵測 | 強制 `h264_nvenc` 或 `libx264` |
| `HOST` / `PORT` | `127.0.0.1` / `3939` | Nitro 監聽位址 |

### API

所有回應都是 JSON（檔案下載除外），型別見 `shared/types/domain.ts`。錯誤用 h3 `createError({ statusCode, statusMessage })`，`statusMessage` 是給使用者看的繁中訊息。

| 方法與路徑 | 內容 |
| --- | --- |
| `GET /api/videos` | `SourceVideo[]`，新的在前 |
| `POST /api/videos` | body `AddVideoBody` → `SourceVideo`；影片資料夾路徑必須在設定的資料夾內；同路徑重複 → 409 |
| `GET /api/videos/:id` | `SourceVideo` |
| `DELETE /api/videos/:id` | 依「從影片庫移除」規則刪除 → `{ ok: true }` |
| `POST /api/videos/:id/retry` | 只限 `failed` → 重新排隊 → `SourceVideo` |
| `GET /api/videos/:id/media` | 預覽或原檔串流（Range） |
| `GET /api/videos/:id/transcript` | `TranscriptSegment[]` |
| `PATCH /api/videos/:id/transcript/:idx` | body `UpdateSegmentBody` → `TranscriptSegment` |
| `GET /api/videos/:id/highlights` | `Highlight[]`（依起點排序） |
| `POST /api/videos/:id/highlights` | body `CreateHighlightBody` → `Highlight`（manual、selected） |
| `PATCH /api/highlights/:id` | body `UpdateHighlightBody` → `Highlight` |
| `GET /api/videos/:id/clips` | `Clip[]`（新的在前） |
| `POST /api/highlights/:id/clips` | body `CreateClipBody` → `Clip`（排隊） |
| `GET /api/clips/:id/file` | 剪輯 mp4（Range；`?download=1` 時為下載，檔名「影片標題_起點_版型.mp4」） |
| `GET /api/clips/:id/srt` | `.srt` 下載 |
| `POST /api/probe` | body `{ filePath }`（必須在影片資料夾內）→ `MediaInfo` |
| `POST /api/uploads` | 原始 body 串流，header `X-File-Name`（encodeURIComponent 過的原檔名）→ `UploadResult` |
| `GET /api/watch-folders/files` | `WatchFolderFile[]` |
| `GET /api/settings` / `PUT /api/settings` | `Settings` |
| `GET /api/system` | `SystemInfo` |

時間一律是「秒」（浮點數），日期是 ISO 字串。

### 驗證輸入

- 精華片段：`0 <= start < end <= 影片長度`，長度至少 0.5 秒。
- 逐字稿文字：去頭尾空白後不可為空，最多 200 字。
- 版型必須是三種之一。

## 測試

- `pnpm test`（Vitest）：純函式單元測試＋用真的 ffmpeg 跑的整合測試。測試素材由 `tests/fixtures/make-fixtures.mjs` 產生（espeak-ng 合成語音 + testsrc2 畫面，含雙音軌 mkv）。
- 轉錄整合測試用 `Systran/faster-whisper-tiny` 在 CPU 上跑。
- 雲端開發環境沒有顯示卡：NVENC、CUDA、Breeze 的實際效果由使用者在 Windows 上確認。
- `pnpm test:e2e`（Playwright）：啟動整個 app 走一次「加入影片 → 分析 → 改逐字稿 → 新增精華片段 → 輸出剪輯」。
