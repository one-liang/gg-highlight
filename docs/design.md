# gg-highlight 設計

這份文件記錄設計討論（grilling）的共識，以及程式的模組分工。用語以 `GLOSSARY.md` 為準，架構決定見 `docs/adr/`。

## 產品行為

### 範圍與原則

- 個人自用，跑在使用者自己的 Windows 電腦（RTX 3060 Ti 8GB、32GB RAM），瀏覽器開 `http://127.0.0.1:3939`；只接受本機連線，沒有帳號。
- 全部用免費、可本機執行的工具：ffmpeg、faster-whisper（Python）、Ollama＋Qwen（里程碑 2，ADR-0002）、yt-dlp（里程碑 3，ADR-0003）。
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
- **YouTube 連結**（里程碑 3）：在「YouTube」分頁貼上連結，先讀取影片資訊，確認後加入；影片檔在第一次分析的 `download` 步驟才下載。細節見「YouTube」。

### 分析（Analysis）

- 背景執行、一次一支（顯示卡只有一張），其他排隊；可以關掉頁面。
- 加入影片庫時自動分析一次。之後可以 **重新分析**（見下方），失敗可以重試；程式中途被關掉，下次啟動時正在跑的分析從頭重跑（同一種模式）。
- 每次分析記下 **模式**（`full`「重新辨識語音並找精華」／`highlights`「只重新找精華片段」，第一次分析一定是 `full`）、**分析版本**（`ANALYSIS_VERSION`，里程碑 2 起為 2；里程碑 1 分析完成的影片是 1）與 **用了哪些訊號**（見「訊號」）。
- `full` 的步驟與進度權重（YouTube 影片前面多一個 `download`，權重見「YouTube」）：`probe`（2%）→ `extract-audio`（5%）→ `transcribe`（60%）→ `prepare-preview`（10%）→ `signals`（21%）→ `candidates`（2%）。
  - `extract-audio`：取「分析用音軌」轉成 16kHz 單聲道 WAV，放在 `data/videos/<id>/audio.wav`，分析結束後刪除。
  - `transcribe`：中文用 Breeze-ASR-25（`SoybeanMilk/faster-whisper-Breeze-ASR-25`），英文用 Whisper large-v3-turbo（`deepdml/faster-whisper-large-v3-turbo-ct2`）。原始結果存 `data/videos/<id>/transcript.raw.json`（不修改），經過「逐字稿清理」再切成字幕大小的逐字稿段落存進資料庫。中文一律經 OpenCC `cn → twp` 轉成台灣正體；OpenCC 會寫成正式的「臺」（台灣 → 臺灣），再換回台灣日常用的「台」。重新分析時，新的逐字稿在這一步成功後才取代舊的。
  - `prepare-preview`：瀏覽器能直接播的檔案（mp4/mov + h264/av1/vp9 + aac/mp3/opus）不另外處理；只有容器不對（例如 OBS 的 mkv）就 remux 成 `data/videos/<id>/preview.mp4`；編碼也不支援才轉成 720p h264（能用 NVENC 就用，NVENC 執行時失敗就用 libx264 重轉一次，見「輸出剪輯」）。預覽一律用音軌 0。
  - `signals`：計算各訊號（見「訊號」），結果存 `data/videos/<id>/signals.json`。步驟內進度：音量 10%、AI 讀逐字稿 90%（依讀完的區段數）。
  - `candidates`：產生候選精華片段（見「候選精華片段」），一次交易取代舊的候選。
- `highlights` 的步驟與權重：`extract-audio`（10%，`signals.json` 裡已有音量時跳過）→ `signals`（85%）→ `candidates`（5%）。不下載 YouTube 影片檔（只重新讀重播熱度，見「YouTube」）。不動逐字稿（保留使用者的修改）、不動預覽；用目前資料庫裡的逐字稿文字給 AI 讀。原始影片檔不見了（或擷取音訊失敗）而且沒有上次的音量時，音量訊號 `missing`（附原因），分析照常完成。
- 沒有音訊的影片在 `probe` 後就失敗（無法辨識語音）；整段都沒說話時逐字稿是空的，只靠音量找候選。

### 重新分析

- 影片頁有「重新分析」的時機：分析完成、「只重新找精華片段」失敗，或之前分析完成過、這次 `full` 失敗或被取消（見下方）。兩種選擇：
  - **只重新找精華片段**（`highlights`）：保留逐字稿與修改，幾分鐘內完成。
  - **重新辨識語音並找精華**（`full`）：逐字稿重新產生，使用者的修改會被覆蓋；修正舊版逐字稿的問題（例如重複幻覺）要用這個。
  - 預設選「只重新找精華片段」的情況：有改過的逐字稿段落（讀不到逐字稿時也當作有）、找不到原始影片檔，或上一次的逐字稿訊號因為可以補救的原因 `missing`（連不到 Ollama、版本太舊、沒有模型、全部區段失敗；`GG_OLLAMA_URL=off` 與「逐字稿沒有內容」不算，再跑一次也不會變）。其他情況選「重新辨識語音並找精華」。
  - 找不到原始影片檔時「重新辨識語音並找精華」不能選：對話框裡停用並寫「找不到原始影片檔，無法重新辨識語音」，舊影片提示的「重新分析全部」也停用。YouTube 影片例外：下載的影片檔不見了也可以選（會重新下載），對話框在這個選項下寫「會重新從 YouTube 下載影片」。
- 不論哪一種：選用、捨棄、手動新增的精華片段，以及有剪輯的精華片段都保留；只有「還是候選、沒輸出過」的分析片段會被新的候選取代（調整過起訖點但沒按「選用」的候選也會被取代）。新的候選不會和保留下來的片段重疊。正在調整或要輸出的候選被取代時，影片頁結束調整、關閉輸出對話框，並提示「這個候選已被新的分析結果取代」。
- 在里程碑 2 之前分析完成的影片（分析版本 1）顯示提示：「這支影片分析時還沒有自動找精華」，可以直接按「找精華片段」（`highlights`）或「重新分析全部」（`full`）。
- 「逐字稿可以用」（`transcriptReady`，前端 `isTranscriptReady` 相同）：分析完成；或這次（排隊、執行或失敗的）是 `highlights`；或 `full` 失敗或被取消、但之前分析完成過（`analysis.version` 不是 null：只在分析成功時寫入，開始新的分析時不會清掉）。`full` 在 transcribe 步驟成功前失敗時舊的逐字稿還在，之後才失敗時新的逐字稿已經完整寫入；精華片段與剪輯都不受影響。
- 規則（依序檢查）：正在排隊或分析中 → 409；`highlights` 需要逐字稿可以用 → 否則 409；`full` 時這支影片還有剪輯在排隊或輸出中 → 409（輸出會讀逐字稿）；`full` 時找不到原始影片檔 → 422（`highlights` 不需要原始檔，見「分析」；YouTube 影片不檢查，`download` 步驟會重新下載）。
- 逐字稿可以用時，逐字稿、精華片段與剪輯照常可以看、改、輸出（「只重新找精華片段」在排隊或執行時也一樣）；不能用時（`full` 在排隊或執行中，逐字稿即將被取代；或第一次分析就失敗、還沒有逐字稿）改逐字稿、新增或調整精華片段、輸出剪輯都回 409，影片頁只顯示進度或失敗訊息。
- 失敗時按「重試」，用同一種模式再跑一次。`full` 的重試規則和 `full` 的重新分析相同（剪輯排隊或輸出中 → 409、找不到原始影片檔 → 422）。之前分析完成過的影片 `full` 失敗或被取消時，影片頁照常顯示工作區，上方寫「重新分析失敗」（或「已取消重新分析」）與錯誤、「逐字稿、精華片段與剪輯照常可以看、改、輸出」，提供「重試」（會再重新辨識語音，覆蓋之後對逐字稿的修改）與「重新分析」（兩種都可以選）。這時原始影片檔也找不到的話，改寫成「逐字稿與精華片段照常可以看、改；原始影片檔放回原位置之前無法預覽或輸出剪輯」（「只重新找精華片段」失敗時是「逐字稿與精華片段不受影響，可以照常查看與修改」），「找不到原始影片檔」提示的最後一句是「把檔案放回原位置後重新整理這一頁，就能再預覽與輸出剪輯」；只有第一次分析就失敗（沒有工作區）時才叫使用者按「重試」。

### 逐字稿清理

辨識結果在切段前先清理（`server/lib/subtitles/cleanup.ts`，純函式、可重複執行結果不變）。GPU 用的批次辨識（`BatchedInferencePipeline`）不支援 faster-whisper 的防幻覺選項（compression ratio、溫度重試等），`repetition_penalty`、`no_repeat_ngram_size` 會吃掉「過來過來」「go go go」這類真的重複，所以不在辨識時處理，而是事後清理：

1. 以字（中文）或單字（英文）為單位；轉錄程式另外輸出每段的 `avgLogprob`、`noSpeechProb`、`compressionRatio`（舊檔沒有也能處理）。
2. 已知的靜音幻覺句（例如「請不吝點贊 訂閱 轉發 打賞支持明鏡與點點欄目」、「字幕由 Amara.org 社區提供」）完全符合時只刪掉這句本身，同一段前後真的說話內容保留。只符合核心片語（例如「明鏡與點點」「請不吝點贊」「Amara.org」）的變形句，連同所在的子句一起刪：子句在標點、0.4 秒以上的停頓、或 Whisper 放在兩個中文字之間的空白處結束，而且每邊最多再多刪 6 個中文字或 3 個英文單字（Whisper 常常沒有標點、字的時間也是連續的，不設上限會把整段真的說話一起刪掉）。例外：「字幕志願者」後面接的是名字，Whisper 會在名字前放空白；那裡沒有停頓、空白後到子句結束只有 1–4 個中文字時就是名字，一起刪掉（「字幕志願者 楊茜茜」），更長的當作真的說話內容保留。「點贊」與「點讚」兩種寫法都算。英文字母的片語只比對完整單字（「Amara.org」算，「Tamara organized」不算）。「謝謝觀看」「Thank you for watching」這類可能真的有人說的，只在整段就是這句、而且信心低時才刪。
3. 有時間資訊時：`noSpeechProb > 0.6` 且 `avgLogprob < -1.0` 的段落刪掉（等同 faster-whisper 一般模式的靜音判斷）。
4. 連續重複縮短：同一個字或片語連續重複超過上限就只留上限（單字 4 次、兩個字 3 次、更長 2 次；英文單字 4 次、2–3 個字 3 次）；中間停頓 1.5 秒以上就不算連續。「快」×22 → 「快快快快」；「過來過來」、「哈哈哈」、「go go go」不變。
5. 刪掉的字連同時間一起拿掉，保留的字時間不變；段落沒有內容了就整段刪掉。
6. 和上一段（保留下來的）文字相同且時間重疊的段落刪掉；連續相同的段落（每段在前一段結束後兩秒內開始）只留前兩段。連續是看原本相鄰的段落，被刪掉的也算，所以一長串相同的段落（例如背景音樂被切成很多段、每段都辨識成同一句）只會留兩段。
7. 清理結果（各規則刪掉幾處）寫進分析 log。

### 訊號

- 判斷一段時間是否精彩的依據，每秒一個 0–1 的值。里程碑 2 有兩種，里程碑 3 加聊天室密度與重播熱度。
- 固定權重：音量 1、逐字稿 2、聊天室 1.5、重播熱度 2；只用「這次有的訊號」重新正規化，缺少的訊號不扣分。
- 每次分析記下每種訊號 `used`（有用到）或 `missing`（沒有，附原因），影片頁顯示「這次的候選依據」。
- **音量**（`loudness`）：讀 `audio.wav`（RIFF 分段解析、串流讀取，不假設 44 位元組標頭），每 0.5 秒算 RMS（dBFS），3 秒滑動平均得到短期響度；和前後各 150 秒的中位數比，高出 3 dB 以上開始計分、高出 12 dB 為滿分；低於 −50 dBFS 一律 0。結果（每秒 dB）存進 `signals.json`，「只重新找精華片段」可以重用。
- **逐字稿**（`transcript`）：本機 Ollama 跑 Qwen（預設 `qwen3.5:9b`，ADR-0002）讀逐字稿：
  - 每 10 分鐘一個區段、前後重疊 60 秒（區段文字超過 12,000 字也會提早結束，讓提示詞放得進 `num_ctx`）；每行一個逐字稿段落，格式 `行號|文字`（不給時間，省 token、模型也比較不會抄錯）。
  - `POST /api/chat`：`think: false`、`stream: true`（避免 Node fetch 的 5 分鐘標頭逾時）、`format` 是這個區段專用的 JSON schema（`highlights` 最多 5 個，每個 `startLine`／`endLine` 為 1..行數的整數、`reason` 最多 40 字、`score` 1–10 的整數，`reason` 在 `score` 前面）、`options`：`num_ctx 16384`（每次相同，避免重新載入模型）、`temperature 0.2`、`top_p 0.8`、`top_k 20`、`presence_penalty 0`、`num_predict 768`、`seed 42`；`keep_alive "1m"`（區段請求一個接一個送，模型不會在中途被卸載；程式來不及卸載就結束時，例如分析中直接關掉視窗，模型一分鐘後也會離開顯示卡）。
  - 提示詞用台灣繁體中文，說明這是遊戲實況的語音辨識文字（會有錯字），什麼算精華（大笑、尖叫、失誤或逆轉、鬥嘴、過關、好笑的對話），什麼不算（打招呼、閒聊、等待、念聊天室或感謝訂閱、技術細節）；6 分是「可以考慮」，低於 6 分（5 分以下，含 5 分；台灣用法「以下」包含本數，所以不寫「6 分以下」）不要回傳，可以回空陣列；理由用一句 20 字以內的台灣繁體中文。
  - 回傳的行號超出範圍就截到範圍內、起訖顛倒就對調、低於 6 分的丟掉（6 分保留）；換成時間：`[第 startLine 行的開始, 第 endLine 行的結束]`，該範圍每秒的值為 `(score − 1) ÷ 9`，重疊取最大值（相鄰區段重疊的 60 秒常讓同一件事回報兩次、其中一次在區段邊界被截斷，所以重疊的片段都保留，只去掉起訖完全相同的重複，留分數高的）。理由經 OpenCC 轉台灣正體、去掉引號、只留第一句、最多 40 字。
  - 開始前檢查：`GET /api/version`（3 秒逾時，需要 0.31.2 以上）與 `GET /api/tags`（模型已下載）。連不到、版本太舊、沒有模型 → 這個訊號 `missing`，附上要怎麼做（「請確認 Ollama 已啟動」「請執行 ollama pull qwen3.5:9b」），分析照常完成。
  - 單一區段失敗（逾時 10 分鐘、回應不是合法 JSON、`done_reason` 是 `length`）→ 用 `temperature 0` 重試一次，還是失敗就跳過這個區段；全部區段都失敗才算 `missing`。跳過的區段（扣掉相鄰區段讀到的部分）不算「AI 沒找到」：那幾秒合成分數時不算逐字稿訊號，只用其他訊號重新正規化（缺少的訊號不扣分），「這次的候選依據」寫「N 個區段讀取失敗」。使用者取消或程式關閉時中止請求，照一般的取消／關閉處理，不算訊號失敗。
  - 結束時（成功、失敗或取消）都送 `{ model, messages: [], keep_alive: 0 }` 卸載模型，讓下一支影片的語音辨識有足夠的顯示卡記憶體。程式在這一步中途結束時，下次啟動復原分析前也先送一次卸載（`GG_OLLAMA_URL=off` 時不送）。
- **聊天室密度**（`chat`）、**重播熱度**（`heatmap`）：只有 YouTube 影片有，規則見「YouTube」。

### 候選精華片段（`candidates` 步驟）

純函式 `buildCandidates`（`server/lib/highlights/`），輸入影片長度、逐字稿段落、各訊號、AI 找到的片段（含理由）與「已被占用的範圍」（保留下來的精華片段）：

1. 合成分數：每秒依權重平均可用的訊號（只算那一秒有值的訊號，見「訊號」的跳過區段），再做 5 秒移動平均。
2. 數量上限：`ceil(影片小時數 × 10)`（15 分鐘的影片最多 3 個）。長度下限 `min(15 秒, 影片長度)`、上限 60 秒。
3. 反覆取目前最高分、而且不在占用範圍內的那一秒（分數低於峰值門檻就停；門檻 = `0.2 × min(1, 3 ÷ 這次用到的訊號權重總和)`：只有音量與逐字稿時就是 0.2，YouTube 多了聊天室與重播熱度時跟著降低，單一訊號的高點不會因為訊號變多就被擋掉）：往兩側擴張，直到分數低於峰值的 60%、碰到占用範圍或達到 60 秒；不足下限時往分數較高的一側補足。
4. 對齊句子：起點移到所在逐字稿段落的開頭、終點移到所在段落的結尾，再各留 1 秒；仍不超過 60 秒（超過就在段落邊界截斷）、不超出影片、不進入占用範圍。
5. 這段範圍（前後再各 5 秒）標成占用，避免候選太密；和已選的候選重疊就合併（合併後仍不超過 60 秒，否則捨棄分數較低的）。
6. 精華分數 = `0.7 × 峰值 + 0.3 × 範圍內平均`（0–1）。精華理由：範圍內 AI 片段分數最高的那個理由；沒有 AI 理由時，看範圍內「權重 × 最高值」最大的訊號：音量「音量突然升高，可能是大叫、爆笑或激動的反應」、聊天室「聊天室突然熱烈起來」、重播熱度「很多觀眾重看這一段（YouTube 重播熱度）」（同分依音量、聊天室、重播熱度的順序）。
7. 結果依起點排序存成 `origin: analysis`、`status: candidate` 的精華片段。

介面：候選分頁依精華分數由高到低排；其他分頁依起點排。分析完成的通知寫出找到幾個候選。

### 音軌規則

- **分析用音軌**（使用者選）只用在語音辨識與訊號偵測。
- **預覽與剪輯**一律用 **音軌 0**：OBS 的音軌 1（ffmpeg 的 `0:a:0`）是全部混音，剪輯要有遊戲聲音與人聲。

### 逐字稿

- 每支原始影片一份，是所有字幕的唯一來源。
- 段落大小：最多約 2 行（中文 26 字、英文約 52 字元），最長約 7 秒，優先在標點與停頓處切開。
- 每個段落都有顯示時間，而且不會因此移動真的說話內容：字的時間戳塌在同一個時間點 T（短於 0.2 秒；辨識迴圈常發生在段落結尾，faster-whisper 的段落結束時間就是最後一個字的結束時間）的幾句，依原本的順序平分 T 之後的空檔（到下一句開始或音訊結束為止），每句最多 1 秒。T 就有一句時間正常的話開始（faster-whisper 下一段常從迴圈塌掉的時間點接著開始）、音訊在 T 結束，或 T 之後的空檔分下來每句不到 0.2 秒而 T 之前的空檔比較多時，改成平分 T 之前的空檔（到前一句結束為止；塌掉的時間點在段落結尾，這些字其實是在它之前說的）。前後都沒有空檔時這句顯示 1 秒、接在同時開始的那句之後。其他兩句開始時間相同的情況，後面那句接在前一句之後，保留它自己的長度（最多 1 秒），不會變成長度 0 而在剪輯字幕裡消失。
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

### YouTube（里程碑 3）

只下載使用者自己擁有或已取得授權的影片；介面在加入時提醒。工具是 yt-dlp（ADR-0003），程式自己管理一份，不用使用者另外安裝。

#### 加入

- 「加入影片」的「YouTube」分頁：貼上連結 → 「讀取影片資訊」（`POST /api/youtube/probe`，通常 5–20 秒）→ 顯示標題、頻道、長度、是不是直播重播、有沒有聊天室重播、有沒有重播熱度，以及授權提醒 → 選語言 → 「下載並開始分析」（`POST /api/videos`）。
- 連結：接受 `youtube.com/watch?v=`、`youtu.be/`、`/live/`、`/shorts/`、`/embed/`、`m.`／`music.`／`youtube-nocookie.com`，以及 YouTube 工作室的 `studio.youtube.com/video/<ID>/…`（實況主管理過去直播的地方，網址列是 `/edit`、`/livestreaming`、`/analytics/…`）；影片 ID 是 11 個 `[A-Za-z0-9_-]` 字元。`list=`、`t=`、`si=` 等參數丟掉，一律轉成 `https://www.youtube.com/watch?v=<ID>`（單一影片，不下載播放清單）。只有播放清單（`/playlist?list=`）、頻道（`/@名稱`、`/channel/`、`/c/`、`/user/`）或搜尋的連結 → 422「不支援播放清單或頻道，請貼單一影片的連結」；不是 YouTube 的連結 → 400「這不是 YouTube 影片連結」。前端用同一個解析函式（`shared/utils/youtube-url.ts`）即時提示。
- 直播狀態（yt-dlp 的 `live_status`）：`not_live`（一般影片）與 `was_live`（直播重播）可以加入；`is_live`、`is_upcoming` → 422「還在直播中或還沒開始的直播不能加入，結束後再來」；`post_live`（剛結束、YouTube 還在處理重播）→ 422「直播剛結束，YouTube 還在處理重播，請過一段時間再加入」。還沒開始的直播與首播沒有可下載的格式，yt-dlp 實際上不會印出 `is_upcoming` 的影片資訊，而是用 YouTube 的說明失敗（`ERROR: … This live event will begin in 3 hours.`、`Premieres in 20 hours`），由錯誤對照表換成同一句 422。
- 同一支 YouTube 影片（同一個 ID）不能重複加入：讀取資訊時回傳 `inLibraryVideoId`，介面顯示「這支影片已在影片庫」並連到那支影片；`POST /api/videos` 重複 → 409。連結的 ID 已在影片庫時，讀取資訊直接用影片庫裡存的資訊回答（不向 YouTube 讀取，`languageHint` 是 null），所以被 YouTube 暫時拒絕或影片後來改成私人時也會顯示「這支影片已在影片庫」。
- 下載後的檔案只有一條音軌，所以 YouTube 影片不選音軌（`audioTrack` 一律 0，其他值 → 400）。語言依影片資訊的語言預選（`zh*` → 中文、`en*` → 英文，其他預設中文）。
- 加入時沒有影片檔，`filePath` 與 `media` 是 null；影片庫與影片頁先用 YouTube 資訊的長度顯示。標題用 YouTube 標題。
- 讀取資訊的結果在記憶體保留 30 分鐘（以 ID 為 key），`POST /api/videos` 與第一次分析的 `download` 步驟直接沿用，不再向 YouTube 讀一次（減少被 YouTube 限流的機會）。
- 不支援私人影片、會員限定影片與需要登入的影片（不讀瀏覽器 Cookie：Windows 上的 Chrome／Edge 新版 Cookie 加密 yt-dlp 讀不到，也有帳號被封的風險）。不公開（unlisted）的影片可以。

#### 下載（分析的 `download` 步驟）

- YouTube 影片的 `full` 分析在 `probe` 前多一個 `download` 步驟：
  1. 影片資訊：30 分鐘內讀過就沿用，否則重新讀（`-J`）；再檢查一次直播狀態（同「加入」的規則，不符就失敗）。取得重播熱度與「有沒有聊天室重播」，更新影片的 YouTube 資訊。影片檔已經在時，讀取失敗（直播狀態不符除外）只寫進 log，照常繼續：聊天室要不要下載依影片庫裡存的 YouTube 資訊，重播熱度用 `signals.json` 裡上次的；影片檔要下載時讀取失敗就是這一步失敗。
  2. 影片檔：已經下載過、檔案還在就沿用（log「沿用已下載的影片檔」）；不在（第一次分析，或檔案被刪掉）就下載。最高 1080p，偏好 H.264＋AAC（`-f "bv*+ba/b" -S "res:1080,vcodec:h264,acodec:aac" --merge-output-format mp4`）：瀏覽器能直接播、不用轉預覽，輸出剪輯也不用解 AV1；代價是檔案比 AV1／VP9 大約 2.5 倍（3 小時的 1080p 直播約 4–8 GB）。影片與音訊分開下載，合併成暫存檔後才刪掉分開的檔案，所以下載時暫時需要約兩倍的空間。存成 `data/downloads/<videoId>.<ext>`，成功後寫入 `filePath`。
  3. 聊天室重播：影片資訊說有、而且 `data/downloads/<videoId>.live_chat.json` 還不存在時，另外跑一次 yt-dlp 下載（`--skip-download --write-subs --sub-langs live_chat`）。聊天室下載失敗只讓聊天室訊號 `missing`（附原因），分析照常繼續。yt-dlp 的聊天室下載不能續傳（會從頭附加在 `.part` 後面，訊息重複），所以每次開始前先刪掉 `<videoId>.live_chat.json.part`；只有最後的 `.json` 存在才算成功（yt-dlp 有些失敗仍回傳 0）。
- 步驟內進度：影片資訊 3%、影片檔 85%、聊天室 12%。影片檔依 yt-dlp 的進度（影片與音訊分兩段下載：第一段佔 90%、第二段 10%；進度行看不出後面還有沒有第二段，所以只有一段時停在 90%，完成時跳到 100%；第二段要等第一段回報完成（`finished`，已經下載過的那段也會回報）才算，因為第一段重試用完失敗時 yt-dlp 還是會先下載音訊才結束，進度不能因此跳到 90%；沒有總位元組時用 `fragment_index ÷ fragment_count`）；聊天室依已寫入最後一行的影片時間 ÷ 影片長度（每秒讀一次 `.part`）。
- 進度權重：需要下載影片檔時 `download`（20%）→ `probe`（1%）→ `extract-audio`（4%）→ `transcribe`（48%）→ `prepare-preview`（7%）→ `signals`（18%）→ `candidates`（2%）；影片檔已經在時 `download`（2%）→ `probe`（2%）→ `extract-audio`（5%）→ `transcribe`（58%）→ `prepare-preview`（10%）→ `signals`（21%）→ `candidates`（2%）。
- 中斷：程式中途關閉時，下次啟動照一般規則從頭重跑 `full`，yt-dlp 會從 `.part` 續傳；下載失敗後按「重試」也一樣續傳。中止工作（關閉程式或從影片庫移除）時結束整個 yt-dlp 行程樹（含 Deno／Node、ffmpeg 子行程）。沒有單獨的「取消下載」：要中途停止只能從影片庫移除，下載到一半的部分會一起刪掉。
- 失敗可以按「重試」（`full`）。錯誤訊息把 yt-dlp 的英文 `ERROR:` 行換成中文（只看 `ERROR:` 開頭的行，`WARNING:` 只寫進 log）。stderr 只在換行（`\n`、`\r\n`）分行：yt-dlp 重試用完時印 `ERROR: \r[download] Got error: <原因>. Giving up after 10 retries`，中間的 `\r` 換成空白，原因才會留在 `ERROR:` 那一行（進度只印在 stdout）。依表格由上而下比對，用第一條符合的規則：

  | yt-dlp 訊息（不分大小寫） | 顯示 |
  | --- | --- |
  | `Private video` | 這是私人影片，無法下載（自己的影片可以先在 YouTube Studio 改成「不公開」再加入） |
  | `members-only`、`Join this channel`、`subscriber_only` | 這是頻道會員限定影片，無法下載 |
  | `confirm your age`、`age-restricted`、`inappropriate` | 這支影片有年齡限制，需要登入才能下載，目前不支援 |
  | `not made this video available in your country`、`geo restrict` | 這支影片在你所在的地區無法觀看 |
  | `live stream recording is not available` | 這場直播沒有保留重播 |
  | `live event will begin`、`Premieres in`、`Premiere will begin`（還沒開始的直播與首播） | 還在直播中或還沒開始的直播不能加入，結束後再來 |
  | `ffmpeg is not installed`、`ffmpeg not found` | 找不到 FFmpeg，請重新執行 setup.bat |
  | 硬碟滿了：`No space left on device`、`[Errno 28]`、`not enough space on the disk`、`WinError 112`、`磁碟空間不足`（下載中或合併影音時） | 硬碟空間不足，請清出空間後再按「重試」（下載會接著來；合併影音時暫時需要約兩倍的空間） |
  | `confirm you[’']re not a bot`、`HTTP Error 429`、`try again later`、`Your IP is likely being blocked` | YouTube 暫時拒絕這台電腦的連線（被當成機器人或請求太頻繁），請過一段時間再按「重試」 |
  | `HTTP Error 403`、`Requested format is not available`、`Unable to extract`、`Signature extraction failed`、`nsig` | YouTube 可能改版了，yt-dlp 需要更新：關掉 gg-highlight 的黑色命令列視窗、再雙擊 start.bat 會自動更新，然後按「重試」 |
  | 網路：`caused by TransportError`／`ProxyError`／`SSLError`／`CertificateVerifyError`／`IncompleteRead`、`getaddrinfo`、`name or service not known`、`nodename nor servname`、`temporary failure in name resolution`、`network is unreachable`、`timed out`、`connection refused`／`reset`／`aborted`、`Connection broken:`、`remote end closed connection`、`Unable to connect to proxy`、`Tunnel connection failed`、`N bytes read, M more expected`、Windows 的錯誤碼 10051／10053／10054／10060／10061／10065（寫成 `[WinError 10054]`，或 `ConnectionResetError(10054, '<系統語言的說明>', None, 10054, None)` 這種形式） | 連不到 YouTube 或連線中斷，請確認網路連線後再試 |
  | `Video unavailable`、`has been removed`、`is not available` | 影片不存在或已被移除 |
  | 找不到 yt-dlp 執行檔 | 找不到 yt-dlp，請重新執行 setup.bat |
  | 其他 | 讀取影片資訊（`-J`）時「向 YouTube 讀取影片資訊失敗：`<原始 ERROR 行>`」；下載影片時「下載失敗：`<原始 ERROR 行>`」；下載聊天室時「聊天室重播下載失敗：`<原始 ERROR 行>`」（完整輸出寫進 log）|

  下載重試用完時的 `ERROR:` 行只有例外本身的文字、沒有 `(caused by …)`：讀取途中連線被切斷是 urllib3 的 `Connection broken: …`（Windows 的錯誤碼只以上面的第二種形式出現，說明是系統語言），Proxy 拒絕連線是 `('Unable to connect to proxy', OSError('Tunnel connection failed: 502 Bad Gateway'))`。硬碟滿了排在 YouTube 那幾列前面：不管 YouTube 那邊怎樣，都要先清出空間。
  較明確的句子排在前面：「live stream recording is not available」與「Requested format is not available」不算「is not available」，YouTube 限流時的「This content isn't available, try again later」算暫時拒絕，「Unable to download webpage: HTTP Error 429／403」算暫時拒絕／可能改版、不算網路問題。有好幾行 `ERROR:` 時也是依表格順序：最上面那條規則只要符合其中任何一行就用它；「其他」用最後一行。yt-dlp 找不到 JavaScript 執行環境時只印 `WARNING:`（不對照）；每次執行都加 `--js-runtimes node:<伺服器的 node>`（Node 22.13 以上），實際上不會發生。
  分析失敗時存成「下載影片失敗：<顯示>」（「其他」去掉「下載失敗：」，是「下載影片失敗：<原始 ERROR 行>」）；直播狀態不符（直播中、還沒開始、剛結束、不是單一影片）的訊息照原樣顯示，不加前綴。讀取影片資訊最多等 90 秒，逾時是「向 YouTube 讀取影片資訊逾時，請稍後再試」。
  「可能改版了」與「其他」兩種情況會讓下次啟動一定檢查 yt-dlp 更新（刪掉檢查紀錄，見「啟動」）；網路問題、硬碟空間不足、還沒開始的直播等其他情況不會。
- 「只重新找精華片段」不下載影片檔；它在 `signals` 步驟開頭重新讀一次影片資訊（只拿重播熱度，最多等 90 秒，不用 30 分鐘的暫存；失敗就用 `signals.json` 裡上次的重播熱度，寫進 log），聊天室檔案不存在而影片資訊說有聊天室重播時也再下載一次（之前聊天室下載失敗的補救方法）。這時 `signals` 步驟內進度：YouTube 資料 10%、音量 10%、AI 讀逐字稿 80%。

#### 聊天室密度（`chat` 訊號）

從 `<videoId>.live_chat.json`（yt-dlp 的格式：一行一個 JSON 動作）每次分析重新計算，不另外快取：

1. 串流逐行讀；不能解析的行跳過（例如被截斷的最後一行）。每行可能有多個動作，逐一看；時間取 `replayChatItemAction.videoOffsetTimeMsec`（沒有就用最外層的 `videoOffsetTimeMsec`），小於 0 或超過影片長度的丟掉。
2. 只算一般訊息、超級留言、超級貼圖（`liveChatTextMessageRenderer`、`liveChatPaidMessageRenderer`、`liveChatPaidStickerRenderer`），其他（系統訊息、會員、贈禮、置頂、刪除）不算。同一個 `id` 只算一次；同一個發言者（`authorExternalChannelId`）5 秒內只算第一則（只在計算時放在記憶體，不存起來）；沒有發言者 ID 的訊息各自算一位。
3. 每則訊息的權重：打招呼或道別（含「晚安、晚上好、午安、早安、安安、哈囉、嗨、大家好、主播好、掰掰、拜拜、下播、辛苦了、報到、hi、hello、bye、88、👋」或 `:hand-pink-waving:`，而且去掉表情代碼後不超過 12 個字；「主播好」後面只能是結尾、標點、空白、表情或語助詞（啊、呀、喔、哦、唷、耶），「主播好猛／好扯／好強」不算；「好嗨」「嗨起來」裡的「嗨」與「安安靜靜」裡的「安安」不算）= 0，同時有打招呼與反應的詞時算打招呼（例如結尾的「晚安!!」）；反應（含「笑死、笑爛、笑翻、哈哈、草、www、XD、lol、lmao、kekw、🤣、😂、？？、!!、！！、好扯、太扯、靠北、救命、嚇死、太神、好猛、神操作、666、nice、gg、ㄏㄏ」）= 2；其他 = 1。
4. 觀眾看到、打字送出需要時間：第 s 秒的密度 `r[s]` = 時間落在 `[s+5, s+25)` 的訊息權重總和（常數 `CHAT_LAG_START_SEC`、`CHAT_WINDOW_SEC` 可調；文獻的延遲從 7 秒到 25 秒都有，台灣實況多用低延遲）。
5. 和平常比：`b[s]` = `r` 前後各 150 秒的中位數（至少 1）；`z = 2(√(r+3/8) − √(b+3/8))`；分數 = `clamp01(min((log2(r/b) − 1) ÷ (log2 6 − 1), (z − 3) ÷ 3))`：比平常多 2 倍而且 `z ≥ 3` 開始計分，6 倍而且 `z ≥ 6` 滿分。`r < 3`，或窗口裡不到 3 位發言者時為 0（避免一兩個人洗版造成假高點）。
6. 整支影片算進來的訊息（權重大於 0）平均每小時不到 120 則 → `missing`「聊天室訊息太少（平均每分鐘不到 2 則），不採用」：很平的聊天室訊號會被算進權重（1.5），讓音量與逐字稿的高點都變低，違反「缺少的訊號不扣分」。常數 `CHAT_MIN_PER_HOUR`。
7. 其他 `missing` 原因：影片資訊沒有聊天室重播 →「這支影片沒有聊天室重播（不是直播重播，或重播剪輯過）」；下載失敗 →「聊天室重播下載失敗：<原因>」（<原因> 只寫原因，不含錯誤對照表裡「請過一段時間再按「重試」」這類動作：分析完成後沒有「重試」可按；介面在後面加上「；之後按「重新分析」→「只重新找精華片段」會再試一次」）；檔案讀不到 →「讀不到聊天室重播檔」。`used` 時 `reason` 寫「平均每分鐘 N 則」（N 不到 10 時取到小數一位，例如 2.5；10 以上取整數）。分析 log 記下每小時則數與判斷。

#### 重播熱度（`heatmap` 訊號）

YouTube 的「最常重播」：觀看次數夠多（大約數萬以上）的影片才有，新影片常常還沒有；yt-dlp 的 `heatmap` 欄位是 YouTube 網頁內部資料，不是正式欄位，隨時可能消失。

1. 格式：`{ start_time, end_time, value }` 的陣列（通常 100 段等長、`value` 0–1，在影片內正規化過，只能和自己比）。時間不合理（`end ≤ start`、不是數字）的段落去掉，剩下不到 10 段就當作沒有重播熱度；依起點排序；`value` 截到 0–1。
2. 開頭 30 秒內開始的段落（YouTube 一般影片開頭常是假的高點）降到不超過中位數。
3. `m` = 中位數、`top` = 最大值；`top − m < 0.1` → `missing`「重播熱度沒有明顯起伏」。
4. 每段分數 `s = clamp01(((v − m) ÷ (top − m) − 0.3) ÷ 0.4)`。
5. 每秒的值：在各段中點之間線性內插（第 k 秒取 `k + 0.5` 的位置），第一個中點之前、最後一個中點之後維持端點的值；超過最後一段結束時間再加一段長度的秒數沒有值（`covered` 為 0）。不另外平滑（合成分數時已有 5 秒移動平均）。
6. 結果（原始陣列與取得時間）存進 `signals.json`。每次分析（`full` 與「只重新找精華片段」）都用這次讀到的（「只重新找精華片段」一定重新讀，後來才出現的重播熱度也會用到）；讀取失敗或這次讀到的資訊沒有重播熱度時，就用 `signals.json` 裡上次的，保留原本的取得時間（避免被 YouTube 限流時讀到不完整的資訊）。
7. `missing` 原因：沒有（這次與上次都沒有）→「這支影片沒有 YouTube 重播熱度（觀看次數不夠多或影片太新）」；讀取失敗而且沒有上次的 →「無法取得重播熱度：<原因>」（<原因> 同「聊天室密度」step 7，只寫原因；介面在後面加上「；之後按「重新分析」→「只重新找精華片段」會再試一次」）。

#### 其他

- 本機影片的「這次的候選依據」不列聊天室與重播熱度；YouTube 影片一律列出（`used` 或 `missing`）。
- 下載的影片檔被手動刪掉時：影片頁寫「下載的影片檔不見了」，「重新辨識語音並找精華」仍然可以選（會重新下載，逐字稿的修改會被覆蓋），「只重新找精華片段」照常可用；預覽與輸出剪輯要等重新下載。
- yt-dlp 的安裝與更新見「啟動」。

### 從影片庫移除

- 確認後刪除：資料庫裡的影片、逐字稿、精華片段、剪輯紀錄；`data/videos/<id>/`、`data/clips/<id>/`；上傳複本；YouTube 的 `data/downloads/<id>.*`（影片檔、下載到一半的 `.part` 與分段檔、聊天室重播檔；還沒下載完、`filePath` 是 null 時也一樣）。啟動時也清掉 `data/downloads/` 裡不屬於任何影片的檔案：檔名開頭（第一個 `.` 之前）是影片 ID 格式（UUID）、但那個 ID 已不在影片庫裡的檔案；其他名稱的檔案與資料夾不動。
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
server/lib/youtube/      yt-dlp：命令列、執行與進度、影片資訊、錯誤訊息、聊天室密度與重播熱度（純函式＋串流讀檔）
server/lib/db/           node:sqlite、schema、repositories
server/lib/library/      影片資料夾、上傳、移除時可刪的檔案
server/lib/http/         Range 檔案傳輸
server/lib/jobs/         分析佇列、輸出佇列
server/lib/services.ts   把上面組起來的單例（給 API routes 用）
shared/types/domain.ts   前後端共用型別
shared/utils/            前後端共用的純函式（YouTube 連結解析）
transcriber/             Python（uv 管理）：gg-transcribe CLI
scripts/                 start.mjs、doctor.mjs、ytdlp.mjs、fetch-fonts.mjs、setup.ps1
tests/                   測試素材產生器、整合測試、e2e
```

`server/lib/**` 一律用明確的 `import`（不依賴 Nitro auto-import），才能直接用 Vitest 測試。

### 啟動（`scripts/start.mjs`，`start.bat` 呼叫）

1. 連接埠已經有 gg-highlight 在跑：只打開瀏覽器。
2. `node_modules` 不存在，或 `package.json`／`pnpm-lock.yaml`／`pnpm-workspace.yaml` 的內容和上次安裝時不同（`node_modules/.gg-install-stamp`，比內容不比修改時間）：先 `pnpm install --config.confirm-modules-purge=false`（`node_modules` 是另一個 pnpm 主版本裝的就直接重建，不停下來問 Y/n）。setup.bat 裝好之後第一次啟動也會確認一次。安裝失敗時不建置，請使用者看上面 pnpm 印出的錯誤訊息，並列出常見原因；找不到 pnpm 時請使用者執行 setup.bat。
3. `app/`、`server/`、`shared/` 或設定檔變了（`.output/.gg-build-stamp`）：`pnpm build`。
4. yt-dlp（沒有設定 `GG_YTDLP_CMD` 時，見下方）：`tools/bin/` 裡沒有就安裝；上次檢查超過 24 小時（或伺服器要求下次檢查）就更新；安裝後與伺服器要求的檢查後確認 yt-dlp 能執行（見下方）。失敗只顯示警告，照常啟動（只影響 YouTube）。
5. 用 `HOST`／`PORT`（預設 `127.0.0.1:3939`）與 `NITRO_SHUTDOWN_TIMEOUT=3000` 啟動伺服器，準備好後打開瀏覽器。
6. Ctrl+C 或關閉視窗：伺服器最多約 6 秒內關閉（等回應 3 秒＋`close` hook 3 秒：中止工作、結束 ffmpeg／轉錄程式、卸載 Ollama 模型）；15 秒還沒結束才強制結束。Windows 關閉視窗時送的是 `SIGHUP`，Nitro 預設只處理 `SIGTERM SIGINT`，所以 `start.mjs` 設定 `NITRO_SHUTDOWN_SIGNALS=SIGTERM SIGINT SIGHUP`，自己也等伺服器關閉。

### yt-dlp（ADR-0003）

- 程式自己管理一份，裝在專案的 `tools/`（不進 git）：`UV_TOOL_DIR=tools/uv`、`UV_TOOL_BIN_DIR=tools/bin`，`uv tool install "yt-dlp[default,deno]"`。`default` 帶入解 YouTube 驗證需要的 `yt-dlp-ejs`，`deno` 帶入沙盒化的 Deno 當 JavaScript 執行環境；另外一律加 `--js-runtimes node:<伺服器的 node 執行檔>` 當備援（yt-dlp 會優先用 Deno）。
- 安裝與更新都在 `scripts/ytdlp.mjs`：setup.bat 呼叫它安裝，`start.mjs` 在伺服器啟動前呼叫它（見「啟動」），所以伺服器執行中不會有檔案被換掉。檢查紀錄是 `tools/.yt-dlp-checked`（內容是時間）；伺服器遇到「可能改版了」或不明的 yt-dlp 錯誤時刪掉它，下次啟動就一定檢查更新。更新用 stable 版；壞掉時的 nightly 指令寫在 README。
- 安裝後，以及伺服器要求的檢查（檢查紀錄被刪掉）更新後，執行一次 `yt-dlp --version`（最多等 30 秒）確認能執行。uv 的工具環境記的是絕對路徑，專案資料夾搬過位置或它用的 Python 被移除時 yt-dlp 就不能執行，`uv tool upgrade` 卻回「Nothing to upgrade」；所以不能執行時 `uv tool install --reinstall --force "yt-dlp[default,deno]"` 重裝一次再確認，還是不行就警告（請使用者刪掉 `tools` 資料夾再啟動），不寫檢查紀錄，下次啟動再試。安裝與重裝都加 `--force`（`tools/bin/` 是程式自己的，覆蓋裡面的執行檔沒有問題）：Windows 上 `tools\bin\yt-dlp.exe` 是複製的檔案、不是捷徑，資料夾搬過位置後 uv 的紀錄還寫著舊位置，不會先刪掉新位置的那一份；沒有 `--force` 時 uv 會以「Executable already exists」失敗，還把剛建好的工具環境刪掉。
- 每次執行都加 `--no-config --no-playlist --no-update`；`--ffmpeg-location` 只在 `GG_FFMPEG` 是存在的絕對路徑時才加（給 `ffmpeg` 這種名稱會讓 yt-dlp 找不到 ffmpeg 而直接失敗）。用參數陣列執行（不經過 shell）、`windowsHide`、`PYTHONUTF8=1`；結束時連子行程（Deno／Node、ffmpeg）一起結束（Windows 用 `taskkill /T /F`）。
- 下載用 `--newline --progress --progress-delta 1 --progress-template "download:GGDL %(info.format_id)s %(progress.{status,downloaded_bytes,total_bytes,total_bytes_estimate,fragment_index,fragment_count})j" --print "after_move:GGFILE %(filepath)j"`；stdout 與 stderr 都要讀。成功 = 結束碼 0 而且有 `GGFILE` 那一行，且檔案存在、在 `data/downloads/` 裡。
- 設定了 `GG_YTDLP_CMD` 就用它（測試用假的 yt-dlp），不自動安裝或更新。

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
data/downloads/<videoId>.<ext> YouTube 下載的影片檔；<videoId>.live_chat.json 是聊天室重播
```

`tools/`（專案根目錄，不在 `data/` 裡）：程式管理的 yt-dlp（見「yt-dlp」）。

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
| `GG_YTDLP_CMD` | `tools/bin/yt-dlp(.exe)` | yt-dlp 指令前綴（可用 JSON 陣列）；設定後不自動安裝或更新，測試一定要設成假的 yt-dlp |
| `GG_OLLAMA_MODEL` | `qwen3.5:9b` | Ollama 模型（空白用預設值；沒寫標籤等於 `:latest`） |
| `HOST` / `PORT` | `127.0.0.1` / `3939` | Nitro 監聽位址。預設值由伺服器自己套用（`server/plugins/startup.ts`），直接執行 `node .output/server/index.mjs` 也只接受本機連線，不會用 Nitro 的 `0.0.0.0:3000` |
| `NITRO_SHUTDOWN_TIMEOUT` | `3000`（`start.mjs` 設定） | 關閉時等待未完成回應（例如播放中的影片串流）的毫秒數，之後強制關閉連線並執行 `close` hook（中止工作、結束 ffmpeg／轉錄程式） |
| `NITRO_SHUTDOWN_SIGNALS` | `SIGTERM SIGINT SIGHUP`（`start.mjs` 設定） | 讓伺服器正常關閉的訊號；`SIGHUP` 是 Windows 關閉命令列視窗時送的（Nitro 預設沒有它，伺服器會立刻結束、來不及卸載 Ollama 模型） |

### API

所有回應都是 JSON（檔案下載除外），型別見 `shared/types/domain.ts`。錯誤用 h3 `createError({ statusCode, statusMessage })`，`statusMessage` 是給使用者看的繁中訊息。

錯誤狀態碼：

| 狀態碼 | 用在 |
| --- | --- |
| 400 | 請求格式不對：不是 JSON、欄位型別或必填欄位錯、逐字稿文字空白或超過 200 字、缺少 `X-File-Name`、沒有 YouTube 連結（「請貼上 YouTube 影片連結」）、不是 YouTube 的連結、YouTube 影片的音軌不是 0（「YouTube 影片只有一條音軌，音軌必須是 0」） |
| 403 | 路徑不在設定的影片資料夾內（`POST /api/videos`、`POST /api/probe`） |
| 404 | 找不到影片／精華片段／剪輯／檔案，或沒有這個 API |
| 405 | 這個 API 路徑不支援這個方法（回應帶 `Allow`；`HEAD` 視同沒有本文的 `GET`） |
| 409 | 狀態不允許：同一路徑或同一支 YouTube 影片重複加入（「這支影片已在影片庫」）、只有 `failed` 可以重試、逐字稿不能用時不能輸出／改逐字稿／新增或調整精華片段（「只重新找精華片段」與之前分析完成過的 `full` 失敗除外，見「重新分析」）、影片資訊還沒讀取完成、重新分析或 `full` 重試的條件不符（見「重新分析」） |
| 415 | 上傳的副檔名不是影片 |
| 422 | 內容不合理：精華片段範圍不對、讀不到影片檔、分析用音軌不存在、原始影片檔不見了無法輸出或重新辨識語音、YouTube 播放清單或頻道連結、直播中／還沒開始／剛結束還在處理的直播、私人／會員限定／有年齡限制／地區限制／已移除的影片 |
| 502 | 向 YouTube 讀取影片資訊失敗：被 YouTube 暫時拒絕、網路問題、逾時、yt-dlp 不見了或需要更新（訊息同「YouTube」的錯誤對照表；其他非預期的錯誤是「向 YouTube 讀取影片資訊失敗，請稍後再試」） |

任何沒有 route 處理的 `/api/**` 請求（包括已知路徑配上錯的方法）都回 JSON 404／405，不會落到 SPA 頁面。

| 方法與路徑 | 內容 |
| --- | --- |
| `GET /api/videos` | `SourceVideo[]`，新的在前 |
| `POST /api/videos` | body `AddVideoBody` → `SourceVideo`；影片資料夾路徑必須在設定的資料夾內；同路徑重複 → 409；YouTube 見「YouTube」（同一支影片重複 → 409） |
| `GET /api/videos/:id` | `SourceVideo` |
| `DELETE /api/videos/:id` | 依「從影片庫移除」規則刪除 → `{ ok: true }` |
| `POST /api/videos/:id/retry` | 只限 `failed` → 用同一種模式重新排隊 → `SourceVideo`；`full` 時的條件同 `full` 的重新分析（剪輯排隊或輸出中 → 409、找不到原始影片檔 → 422） |
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
| `POST /api/youtube/probe` | body `YoutubeProbeBody`（`{ url }`）→ `YoutubeInfo`；最多等 90 秒；已在影片庫的影片直接用存的資訊回答（不讀 YouTube）；錯誤見「YouTube」（400／422／502） |
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
- yt-dlp 一律用假的（`server/lib/youtube/test-helpers/fake-yt-dlp.mjs`，由 `GG_YTDLP_CMD` 指定）：依連結裡的影片 ID 決定情境（直播重播含聊天室與重播熱度、沒有聊天室（英文影片，`language: en-US`）、沒有重播熱度、直播中、還沒開始的直播（`-J` 以 `This live event will begin…` 失敗，同真的 yt-dlp）、私人影片、聊天室下載失敗、下載 403、重試用完（`ERROR: \r[download] Got error: …`：影片 403、聊天室 429）、下載很慢），下載時複製 `GG_FAKE_YTDLP_MEDIA` 指定的測試影片並印出進度。整合測試（`tests/integration/server.ts`）與 e2e（`playwright.config.ts`）啟動的伺服器預設都用它。雲端環境下載不了 YouTube 影片（Google 拒絕資料中心的 IP）；真的下載由使用者在 Windows 上確認。
- 雲端開發環境沒有顯示卡：NVENC、CUDA、Breeze 的實際效果由使用者在 Windows 上確認。
- `pnpm test:e2e`（Playwright）：啟動整個 app 走一次「加入影片 → 分析 → 改逐字稿 → 新增精華片段 → 輸出剪輯」，以及「候選精華片段 → 選用 → 輸出 → 重新分析（只重新找精華片段，保留修改與選用的片段）→ Ollama 沒有模型時只用音量 → 設定頁的 Ollama 狀態 → 舊影片的提示」，和「YouTube：貼連結 → 讀取資訊 → 下載並分析 → 候選依據列出聊天室與重播熱度 → 同一支影片再貼一次是重複 → 移除後下載檔刪除」、下載中移除（下載到一半的檔案一起刪除），與錯誤情境（播放清單、不是 YouTube、私人影片與「重試」按鈕、直播中、還沒開始的直播），以及英文影片預選英文。
- Ollama 一律用假的 HTTP 伺服器（`server/lib/llm/test-helpers/fake-ollama.mjs`）：單元、整合、e2e 共用，可以模擬正常、沒有模型、連不到、回應壞掉、卡住。e2e 由 `playwright.config.ts` 啟動它（`webServer`，情境 `ok`），測試用 `POST $GG_E2E_OLLAMA_URL/__scenario` 切換情境。雲端環境不能執行真的 Ollama；實際模型的效果由使用者在 Windows 上確認。
