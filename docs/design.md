# gg-highlight 設計

這份文件記錄設計討論（grilling）的共識，以及程式的模組分工。用語以 `GLOSSARY.md` 為準，架構決定見 `docs/adr/`。

## 產品行為

### 範圍與原則

- 個人自用，跑在使用者自己的 Windows 電腦（RTX 3060 Ti 8GB、32GB RAM），瀏覽器開 `http://127.0.0.1:3939`；只接受本機連線，沒有帳號。
- 全部用免費、可本機執行的工具：ffmpeg、faster-whisper（Python）、Ollama＋Qwen（里程碑 2，ADR-0002）、yt-dlp（里程碑 3）。
- 介面全部繁體中文；程式碼用英文命名，對應 GLOSSARY 的英文名稱。

### 里程碑

1. **字幕剪輯**：本機影片 → 逐字稿（可編輯）→ 手動新增精華片段 → 用三種版型輸出帶字幕的剪輯。
2. **自動找精華**：音量與逐字稿（本機 LLM）兩種訊號、候選精華片段、精華分數與精華理由。
3. **YouTube**：連結下載、聊天室密度、重播熱度。

### 加入影片

- **影片資料夾**：設定頁指定一或多個資料夾（例如 OBS 錄影資料夾），系統列出其中的影片檔（不遞迴），挑選後直接引用原檔，不複製。
- **拖拉上傳**：在「加入影片」的「上傳檔案」分頁選擇或拖入檔案，串流寫入 `data/uploads/`（會佔一份空間）。上傳後先 probe，再選語言與音軌。拖到頁面其他地方的檔案一律忽略（不會讓瀏覽器打開檔案而離開 app、中斷上傳）。
- 加入時選 **語言**（`zh` 中文含中英夾雜／`en` 英文）與 **分析用音軌**（預設 0）。系統用 ffprobe 列出音軌讓使用者選。
- 加入時就 probe 一次並存下影片資訊（長度、解析度、音軌），所以影片頁在分析完成前就能顯示長度；讀不到影片或選的音軌不存在 → 422，不會加入。分析的 `probe` 步驟會再讀一次（檔案可能在排隊期間換過）。
- 同一個檔案路徑不能重複加入影片庫。

### 分析（Analysis）

- 背景執行、一次一支（顯示卡只有一張），其他排隊；可以關掉頁面。
- 加入影片庫時自動分析一次。之後可以 **重新分析**（見下方），失敗可以重試；程式中途被關掉，下次啟動時正在跑的分析從頭重跑（同一種模式）。
- 每次分析記下 **模式**（`full` 全部／`highlights` 只找精華）、**分析版本**（`ANALYSIS_VERSION`，里程碑 2 起為 2；里程碑 1 分析完成的影片是 1）與 **用了哪些訊號**（見「訊號」）。
- `full` 的步驟與進度權重：`probe`（2%）→ `extract-audio`（5%）→ `transcribe`（60%）→ `prepare-preview`（10%）→ `signals`（21%）→ `candidates`（2%）。
  - `extract-audio`：取「分析用音軌」轉成 16kHz 單聲道 WAV，放在 `data/videos/<id>/audio.wav`，分析結束後刪除。
  - `transcribe`：中文用 Breeze-ASR-25（`SoybeanMilk/faster-whisper-Breeze-ASR-25`），英文用 Whisper large-v3-turbo（`deepdml/faster-whisper-large-v3-turbo-ct2`）。原始結果存 `data/videos/<id>/transcript.raw.json`（不修改），經過「逐字稿清理」再切成字幕大小的逐字稿段落存進資料庫。中文一律經 OpenCC `cn → twp` 轉成台灣正體；OpenCC 會寫成正式的「臺」（台灣 → 臺灣），再換回台灣日常用的「台」。重新分析時，新的逐字稿在這一步成功後才取代舊的。
  - `prepare-preview`：瀏覽器能直接播的檔案（mp4/mov + h264/av1/vp9 + aac/mp3/opus）不另外處理；只有容器不對（例如 OBS 的 mkv）就 remux 成 `data/videos/<id>/preview.mp4`；編碼也不支援才轉成 720p h264（能用 NVENC 就用，NVENC 執行時失敗就用 libx264 重轉一次，見「輸出剪輯」）。預覽一律用音軌 0。
  - `signals`：計算各訊號（見「訊號」），結果存 `data/videos/<id>/signals.json`。步驟內進度：音量 10%、AI 讀逐字稿 90%（依讀完的區段數）。
  - `candidates`：產生候選精華片段（見「候選精華片段」），一次交易取代舊的候選。
- `highlights` 的步驟與權重：`extract-audio`（10%，`signals.json` 裡已有音量時跳過）→ `signals`（85%）→ `candidates`（5%）。不動逐字稿（保留使用者的修改）、不動預覽；用目前資料庫裡的逐字稿文字給 AI 讀。原始影片檔不見了（或擷取音訊失敗）而且沒有上次的音量時，音量訊號 `missing`（附原因），分析照常完成。
- 沒有音訊的影片在 `probe` 後就失敗（無法辨識語音）；整段都沒說話時逐字稿是空的，只靠音量找候選。

### 重新分析

- 分析完成（或「只找精華」失敗）的影片，影片頁有「重新分析」，兩種選擇：
  - **只重新找精華片段**（`highlights`）：保留逐字稿與修改，幾分鐘內完成。
  - **重新辨識語音並找精華**（`full`）：逐字稿重新產生，使用者的修改會被覆蓋；修正舊版逐字稿的問題（例如重複幻覺）要用這個。
  - 預設：有改過的逐字稿段落時選「只重新找精華」，否則選「重新辨識」。
- 不論哪一種：選用、捨棄、手動新增的精華片段，以及有剪輯的精華片段都保留；只有「還是候選、沒輸出過」的分析片段會被新的候選取代。新的候選不會和保留下來的片段重疊。
- 在里程碑 2 之前分析完成的影片（分析版本 1）顯示提示：「這支影片分析時還沒有自動找精華」，可以直接按「找精華片段」（`highlights`）或「重新分析全部」（`full`）。
- 規則（依序檢查）：正在排隊或分析中 → 409；`highlights` 需要已經有逐字稿（分析完成，或上一次是 `highlights`）→ 否則 409；`full` 時這支影片還有剪輯在排隊或輸出中 → 409（輸出會讀逐字稿）；`full` 時找不到原始影片檔 → 422（`highlights` 不需要原始檔，見「分析」）。
- 「只找精華」在排隊、執行或失敗時，逐字稿、精華片段與剪輯照常可以看、改、輸出；`full` 在排隊、執行或失敗時則跟第一次分析一樣，要等分析完成才能操作（失敗時按「重試」，用同一種模式再跑一次）。改逐字稿、新增或調整精華片段、輸出剪輯在這時都回 409。

### 逐字稿清理

辨識結果在切段前先清理（`server/lib/subtitles/cleanup.ts`，純函式、可重複執行結果不變）。GPU 用的批次辨識（`BatchedInferencePipeline`）不支援 faster-whisper 的防幻覺選項（compression ratio、溫度重試等），`repetition_penalty`、`no_repeat_ngram_size` 會吃掉「過來過來」「go go go」這類真的重複，所以不在辨識時處理，而是事後清理：

1. 以字（中文）或單字（英文）為單位；轉錄程式另外輸出每段的 `avgLogprob`、`noSpeechProb`、`compressionRatio`（舊檔沒有也能處理）。
2. 已知的靜音幻覺句（例如「請不吝點贊 訂閱 轉發 打賞支持明鏡與點點欄目」、「字幕由 Amara.org 社區提供」）整句刪掉；「謝謝觀看」「Thank you for watching」這類可能真的有人說的，只在整段就是這句、而且信心低時才刪。
3. 有時間資訊時：`noSpeechProb > 0.6` 且 `avgLogprob < -1.0` 的段落刪掉（等同 faster-whisper 一般模式的靜音判斷）。
4. 連續重複縮短：同一個字或片語連續重複超過上限就只留上限（單字 4 次、兩個字 3 次、更長 2 次；英文單字 4 次、2–3 個字 3 次）；中間停頓 1.5 秒以上就不算連續。「快」×22 → 「快快快快」；「過來過來」、「哈哈哈」、「go go go」不變。
5. 刪掉的字連同時間一起拿掉，保留的字時間不變；段落沒有內容了就整段刪掉。
6. 和上一段文字相同且時間重疊的段落刪掉；兩秒內連續三段以上相同只留兩段。
7. 清理結果（各規則刪掉幾處）寫進分析 log。

### 訊號

- 判斷一段時間是否精彩的依據，每秒一個 0–1 的值。里程碑 2 有兩種，里程碑 3 加聊天室密度與重播熱度。
- 固定權重：音量 1、逐字稿 2（里程碑 3：聊天室 1.5、重播熱度 2）；只用「這次有的訊號」重新正規化，缺少的訊號不扣分。
- 每次分析記下每種訊號 `used`（有用到）或 `missing`（沒有，附原因），影片頁顯示「這次的候選依據」。
- **音量**（`loudness`）：讀 `audio.wav`（RIFF 分段解析、串流讀取，不假設 44 位元組標頭），每 0.5 秒算 RMS（dBFS），3 秒滑動平均得到短期響度；和前後各 150 秒的中位數比，高出 3 dB 以上開始計分、高出 12 dB 為滿分；低於 −50 dBFS 一律 0。結果（每秒 dB）存進 `signals.json`，「只找精華」可以重用。
- **逐字稿**（`transcript`）：本機 Ollama 跑 Qwen（預設 `qwen3.5:9b`，ADR-0002）讀逐字稿：
  - 每 10 分鐘一個區段、前後重疊 60 秒（區段文字超過 12,000 字也會提早結束，讓提示詞放得進 `num_ctx`）；每行一個逐字稿段落，格式 `行號|文字`（不給時間，省 token、模型也比較不會抄錯）。
  - `POST /api/chat`：`think: false`、`stream: true`（避免 Node fetch 的 5 分鐘標頭逾時）、`format` 是這個區段專用的 JSON schema（`highlights` 最多 5 個，每個 `startLine`／`endLine` 為 1..行數的整數、`reason` 最多 40 字、`score` 1–10 的整數，`reason` 在 `score` 前面）、`options`：`num_ctx 16384`（每次相同，避免重新載入模型）、`temperature 0.2`、`top_p 0.8`、`top_k 20`、`presence_penalty 0`、`num_predict 768`、`seed 42`；`keep_alive "10m"`。
  - 提示詞用台灣繁體中文，說明這是遊戲實況的語音辨識文字（會有錯字），什麼算精華（大笑、尖叫、失誤或逆轉、鬥嘴、過關、好笑的對話），什麼不算（打招呼、閒聊、等待、念聊天室或感謝訂閱、技術細節）；6 分以下不要回傳，可以回空陣列；理由用一句 20 字以內的台灣繁體中文。
  - 回傳的行號超出範圍就截到範圍內、起訖顛倒就對調、低於 6 分的丟掉（6 分保留）；換成時間：`[第 startLine 行的開始, 第 endLine 行的結束]`，該範圍每秒的值為 `(score − 1) ÷ 9`，重疊取最大值。理由經 OpenCC 轉台灣正體、去掉引號、只留第一句、最多 40 字。
  - 開始前檢查：`GET /api/version`（3 秒逾時，需要 0.31.2 以上）與 `GET /api/tags`（模型已下載）。連不到、版本太舊、沒有模型 → 這個訊號 `missing`，附上要怎麼做（「請確認 Ollama 已啟動」「請執行 ollama pull qwen3.5:9b」），分析照常完成。
  - 單一區段失敗（逾時 10 分鐘、回應不是合法 JSON、`done_reason` 是 `length`）→ 用 `temperature 0` 重試一次，還是失敗就跳過這個區段；全部區段都失敗才算 `missing`。使用者取消或程式關閉時中止請求，照一般的取消／關閉處理，不算訊號失敗。
  - 結束時（成功、失敗或取消）都送 `{ model, messages: [], keep_alive: 0 }` 卸載模型，讓下一支影片的語音辨識有足夠的顯示卡記憶體。
- **聊天室密度**（`chat`）、**重播熱度**（`heatmap`）：里程碑 3（YouTube）。

### 候選精華片段（`candidates` 步驟）

純函式 `buildCandidates`（`server/lib/highlights/`），輸入影片長度、逐字稿段落、各訊號、AI 找到的片段（含理由）與「已被占用的範圍」（保留下來的精華片段）：

1. 合成分數：每秒依權重平均可用的訊號，再做 5 秒移動平均。
2. 數量上限：`ceil(影片小時數 × 10)`（15 分鐘的影片最多 3 個）。長度下限 `min(15 秒, 影片長度)`、上限 60 秒。
3. 反覆取目前最高分、而且不在占用範圍內的那一秒（分數低於 0.2 就停）：往兩側擴張，直到分數低於峰值的 60%、碰到占用範圍或達到 60 秒；不足下限時往分數較高的一側補足。
4. 對齊句子：起點移到所在逐字稿段落的開頭、終點移到所在段落的結尾，再各留 1 秒；仍不超過 60 秒（超過就在段落邊界截斷）、不超出影片、不進入占用範圍。
5. 這段範圍（前後再各 5 秒）標成占用，避免候選太密；和已選的候選重疊就合併（合併後仍不超過 60 秒，否則捨棄分數較低的）。
6. 精華分數 = `0.7 × 峰值 + 0.3 × 範圍內平均`（0–1）。精華理由：範圍內 AI 片段分數最高的那個理由；沒有 AI 理由時依音量寫「音量突然升高，可能是大叫、爆笑或激動的反應」。
7. 結果依起點排序存成 `origin: analysis`、`status: candidate` 的精華片段。

介面：候選分頁依精華分數由高到低排；其他分頁依起點排。分析完成的通知寫出找到幾個候選。

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
- 畫面上的影片長度是四捨五入過的（0.1 秒，超過一小時或標題列為整秒），可能比實際長度多到 0.5 秒；所以終點可以超過影片長度 0.5 秒以內，存成影片長度。錯誤訊息裡的長度一律無條件捨去，訊息寫的值本身一定可以用。
- 分析產生的候選見「候選精華片段」：長度 15–60 秒、對齊句子邊界且前後各留約 1 秒、重疊的合併、依精華分數排序、每小時影片最多約 10 個、缺少的訊號不扣分。

### 輸出剪輯

- 對一個精華片段按「輸出」：選版型（預設模糊背景）與是否燒錄字幕（預設是）。每次輸出都是一支新剪輯，記下當下的起訖點；之後改精華片段或逐字稿都不影響已輸出的剪輯。
- 版型：
  - `blurred-background`：1080×1920，原畫面等比縮到寬 1080 置中，背景是放大裁切後模糊的同一畫面。
  - `center-crop`：1080×1920，從原畫面中央裁出 9:16 再縮放。
  - `original`：維持原比例與解析度，最高 1080p（寬高取偶數）。
- 影格率維持原樣；能用 NVENC 就用 `h264_nvenc`，否則 `libx264`；音訊為音軌 0 轉 AAC；`+faststart`。
- NVENC 在啟動時的測試編碼通過，執行時仍可能失敗（例如 OBS 正在用 NVENC 錄影、佔滿編碼工作階段）：`h264_nvenc` 的 ffmpeg 失敗且不是被中止的，就自動用 `libx264` 重做一次並寫進 log；`libx264` 也失敗才算輸出失敗（顯示 `libx264` 的錯誤）。
- 字幕：ASS 檔燒錄，字型 Noto Sans CJK TC（`fonts/` 資料夾），大字、白字黑邊、置中偏下、最多兩行。同時一定輸出對應的 `.srt`（時間以剪輯開頭為 0）。
  - libass 把 ASS 的 Fontsize 當成字型的 ascender + descender，Noto Sans CJK 約 1.45 em：Fontsize 100 畫出的中文字約 69 px 寬。每行能放幾個字依這個實際字寬算：`floor((寬 − 2 × 左右邊界) ÷ (Fontsize ÷ 1.45))`。
  - 直式版型（1080×1920）：Fontsize 100、黑邊 6、左右邊界 60、下邊界 440（剛好在模糊背景中間那條 16:9 畫面下方）；一行 13 個中文字，兩行 26 字，等於逐字稿段落的上限。
  - 原比例版型：Fontsize = 短邊 × 7.5%（1080p 為 81）、黑邊 = Fontsize ÷ 14（至少 2）、左右邊界 = 寬 × 5%、下邊界 = 高 × 6%。
  - 段落被使用者改得太長（最多 200 字），或是英文大寫這類比字數估計更寬的文字，兩行放不下時，依字型實際字寬縮小那一句的字級（ASS `\fs`），讓字幕留在左右邊界內，不會超出畫面。
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
server/lib/signals/      訊號：音量（讀 WAV）、AI 片段轉成每秒的值、合成（純函式＋串流讀檔）
server/lib/llm/          Ollama client 與「AI 讀逐字稿」（分段、提示詞、schema、驗證回應）
server/lib/highlights/   候選精華片段產生（純函式）
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

### 啟動（`scripts/start.mjs`，`start.bat` 呼叫）

1. 連接埠已經有 gg-highlight 在跑：只打開瀏覽器。
2. `node_modules` 不存在，或 `package.json`／`pnpm-lock.yaml`／`pnpm-workspace.yaml` 的內容和上次安裝時不同（`node_modules/.gg-install-stamp`，比內容不比修改時間）：先 `pnpm install --config.confirm-modules-purge=false`（`node_modules` 是另一個 pnpm 主版本裝的就直接重建，不停下來問 Y/n）。setup.bat 裝好之後第一次啟動也會確認一次。安裝失敗時不建置，請使用者看上面 pnpm 印出的錯誤訊息，並列出常見原因；找不到 pnpm 時請使用者執行 setup.bat。
3. `app/`、`server/`、`shared/` 或設定檔變了（`.output/.gg-build-stamp`）：`pnpm build`。
4. 用 `HOST`／`PORT`（預設 `127.0.0.1:3939`）與 `NITRO_SHUTDOWN_TIMEOUT=3000` 啟動伺服器，準備好後打開瀏覽器。
5. Ctrl+C 或關閉視窗：伺服器最多約 6 秒內關閉（等回應 3 秒＋`close` hook 3 秒）；15 秒還沒結束才強制結束。

### pnpm 版本

- 支援 pnpm 10.5 以上（10、11、12）。設定在 `pnpm-workspace.yaml`：`packages: ['.']`（pnpm 9 與 10.0–10.4 沒有它會報錯），以及安裝腳本許可 `allowBuilds`（10.26 以上、11、12）與 `onlyBuiltDependencies`（10.5–10.25）兩份相同的清單。pnpm 11 以上遇到沒有列入許可、又有安裝腳本的套件，會讓安裝失敗（`ERR_PNPM_IGNORED_BUILDS`）；10.0–10.4 不讀這個檔案的許可，會跳過 esbuild 與 vue-demi 的安裝腳本。
- setup.bat：沒有 pnpm、pnpm 無法執行，或版本低於 10.5 時，執行 `npm install -g pnpm@10`（pnpm 10 的最新版）；已經是 10.5 以上（包括 11、12）就沿用，不降級。更新後找到的還是舊版（PATH 上排在前面的是別的 pnpm）就停下來，顯示它的位置。
- `scripts/doctor.mjs` 把低於 10.5 的 pnpm 列為必要項目沒通過。

### 資料夾 `data/`

```
data/gg-highlight.db          SQLite
data/videos/<videoId>/        audio.wav（分析中）、transcript.raw.json、signals.json、preview.mp4
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
| `GG_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama 位址（空白用預設值、結尾的 `/` 會去掉）；設成 `off`（不分大小寫）就不用 AI 讀逐字稿（逐字稿訊號一律 `missing`），測試一定要設成假的伺服器或 `off` |
| `GG_OLLAMA_MODEL` | `qwen3.5:9b` | Ollama 模型（空白用預設值；沒寫標籤等於 `:latest`） |
| `HOST` / `PORT` | `127.0.0.1` / `3939` | Nitro 監聽位址。預設值由伺服器自己套用（`server/plugins/startup.ts`），直接執行 `node .output/server/index.mjs` 也只接受本機連線，不會用 Nitro 的 `0.0.0.0:3000` |
| `NITRO_SHUTDOWN_TIMEOUT` | `3000`（`start.mjs` 設定） | 關閉時等待未完成回應（例如播放中的影片串流）的毫秒數，之後強制關閉連線並執行 `close` hook（中止工作、結束 ffmpeg／轉錄程式） |

### API

所有回應都是 JSON（檔案下載除外），型別見 `shared/types/domain.ts`。錯誤用 h3 `createError({ statusCode, statusMessage })`，`statusMessage` 是給使用者看的繁中訊息。

錯誤狀態碼：

| 狀態碼 | 用在 |
| --- | --- |
| 400 | 請求格式不對：不是 JSON、欄位型別或必填欄位錯、逐字稿文字空白或超過 200 字、缺少 `X-File-Name` |
| 403 | 路徑不在設定的影片資料夾內（`POST /api/videos`、`POST /api/probe`） |
| 404 | 找不到影片／精華片段／剪輯／檔案，或沒有這個 API |
| 405 | 這個 API 路徑不支援這個方法（回應帶 `Allow`；`HEAD` 視同沒有本文的 `GET`） |
| 409 | 狀態不允許：同一路徑重複加入、只有 `failed` 可以重試、分析完成前不能輸出／改逐字稿／新增或調整精華片段（「只找精華」除外，見「重新分析」）、影片資訊還沒讀取完成、重新分析的條件不符（見「重新分析」） |
| 415 | 上傳的副檔名不是影片 |
| 422 | 內容不合理：精華片段範圍不對、讀不到影片檔、分析用音軌不存在、原始影片檔不見了無法輸出或重新辨識語音 |

任何沒有 route 處理的 `/api/**` 請求（包括已知路徑配上錯的方法）都回 JSON 404／405，不會落到 SPA 頁面。

| 方法與路徑 | 內容 |
| --- | --- |
| `GET /api/videos` | `SourceVideo[]`，新的在前 |
| `POST /api/videos` | body `AddVideoBody` → `SourceVideo`；影片資料夾路徑必須在設定的資料夾內；同路徑重複 → 409 |
| `GET /api/videos/:id` | `SourceVideo` |
| `DELETE /api/videos/:id` | 依「從影片庫移除」規則刪除 → `{ ok: true }` |
| `POST /api/videos/:id/retry` | 只限 `failed` → 用同一種模式重新排隊 → `SourceVideo` |
| `POST /api/videos/:id/reanalyze` | body `ReanalyzeBody`（`{ mode: 'full' \| 'highlights' }`）→ 排隊 → `SourceVideo`（`analysis.status` 為 `queued`、`mode` 為要求的模式）；條件見「重新分析」 |
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
| `GET /api/system` | `SystemInfo`（含 Ollama 狀態：最多等 1.5 秒，連不到也不會讓這個 API 失敗） |

時間一律是「秒」（浮點數），日期是 ISO 字串。

### 驗證輸入

- 精華片段：`0 <= start < end <= 影片長度`，長度至少 0.5 秒；終點超過影片長度 0.5 秒以內時存成影片長度（見「精華片段」）。
- 逐字稿文字：去頭尾空白後不可為空，最多 200 字。
- 版型必須是三種之一。

## 測試

- `pnpm test`（Vitest）：純函式單元測試＋用真的 ffmpeg 跑的整合測試。測試素材由 `tests/fixtures/make-fixtures.mjs` 產生（espeak-ng 合成語音 + testsrc2 畫面，含雙音軌 mkv，以及給候選精華片段用的一分鐘影片 `highlights-zh.mkv`：開頭是中文語音，40–46 秒有一段只有音量訊號找得到的大聲響）。
- 轉錄整合測試用 `Systran/faster-whisper-tiny` 在 CPU 上跑。
- 雲端開發環境沒有顯示卡：NVENC、CUDA、Breeze 的實際效果由使用者在 Windows 上確認。
- `pnpm test:e2e`（Playwright）：啟動整個 app 走一次「加入影片 → 分析 → 改逐字稿 → 新增精華片段 → 輸出剪輯」，以及「候選精華片段 → 選用 → 輸出 → 重新分析（只找精華，保留修改與選用的片段）→ Ollama 沒有模型時只用音量 → 設定頁的 Ollama 狀態 → 舊影片的提示」。
- Ollama 一律用假的 HTTP 伺服器（`server/lib/llm/test-helpers/fake-ollama.mjs`）：單元、整合、e2e 共用，可以模擬正常、沒有模型、連不到、回應壞掉、卡住。e2e 由 `playwright.config.ts` 啟動它（`webServer`，情境 `ok`），測試用 `POST $GG_E2E_OLLAMA_URL/__scenario` 切換情境。雲端環境不能執行真的 Ollama；實際模型的效果由使用者在 Windows 上確認。
