# gg-highlight

個人自用的影片精華工具：把一支錄影（例如 OBS 的實況錄影）轉成逐字稿，自動找出可能精彩的段落，挑出想要的，剪成**帶字幕的直式短影片**（Shorts／Reels／TikTok），或原比例的剪輯。

- 全部在自己的電腦上執行，免費、不用帳號，也不會把影片上傳到任何地方。
- 語音辨識用本機的 faster-whisper：中文用 [Breeze-ASR-25](https://huggingface.co/MediaTek-Research/Breeze-ASR-25)（台灣口音、中英夾雜），英文用 Whisper large-v3-turbo。
- 自動找精華看兩種訊號：音量高點，以及本機 AI（[Ollama](https://ollama.com) 跑 Qwen3.5）讀逐字稿；每個候選精華片段都有精華分數與一句精華理由。
- 剪輯用 ffmpeg；有 NVIDIA 顯示卡時用 NVENC 硬體編碼。
- 介面是繁體中文，在瀏覽器裡操作（`http://127.0.0.1:3939`）。

## 目前進度

| 里程碑 | 內容 | 狀態 |
| --- | --- | --- |
| 1 字幕剪輯 | 本機影片 → 逐字稿（可修改）→ 手動新增精華片段 → 用三種版型輸出帶字幕的剪輯與 `.srt` | ✅ 已完成 |
| 2 自動找精華 | 依音量高點與逐字稿內容（本機 LLM，Ollama）自動產生候選精華片段、精華分數與理由；重新分析；清理語音辨識的重複幻覺 | ✅ 已完成 |
| 3 YouTube | 貼上 YouTube 連結下載分析、聊天室密度、重播熱度 | 🚧 開發中 |

## 系統需求

- **Windows 10 或 11（64 位元）**。安裝程式需要 winget（Windows 11 內建；Windows 10 請到 Microsoft Store 安裝「應用程式安裝程式」）。
- **建議有 NVIDIA 顯示卡**（例如 RTX 3060 Ti 8GB）並安裝最新驅動程式。沒有的話也能用，但語音辨識改用 CPU，一小時的影片可能要跑好幾個小時；輸出剪輯也會改用 CPU 編碼。
- **Ollama 0.31.2 以上**與模型 **qwen3.5:9b**（自動找精華讀逐字稿用，setup.bat 會安裝與下載）。8 GB 的顯示卡放不下整個模型時，Ollama 會把一小部分放在 CPU 上跑，比較慢但能用（見「疑難排解」的 `ollama ps`）。沒有 Ollama 也能用，只是自動找精華只看音量。
- **記憶體**：16 GB 以上比較順。
- **硬碟空間**：
  - 語音辨識模型約 5 GB（中文 Breeze-ASR-25 約 3 GB、英文 large-v3-turbo 約 1.6 GB），放在 Hugging Face 快取（`%USERPROFILE%\.cache\huggingface`）。
  - Ollama 模型 qwen3.5:9b 約 6.6 GB，放在 `%USERPROFILE%\.ollama\models`（要換位置可以設定 Ollama 的環境變數 `OLLAMA_MODELS`）。
  - Python 環境約 1–2 GB、Node.js 套件約 0.5 GB。
  - 再加上影片：拖拉上傳的影片會複製一份到 `data/uploads/`；輸出的剪輯放在 `data/clips/`。從「影片資料夾」加入的影片不會複製。

## 安裝

1. 下載這個專案（`git clone`，或在 GitHub 下載 ZIP 後解壓縮）到一個你找得到的資料夾，例如 `D:\gg-highlight`。
   - 如果是下載 ZIP：解壓縮前先在 ZIP 檔上按右鍵 →「內容」→ 勾選「解除封鎖」，不然 Windows 可能會擋住批次檔。
2. 在資料夾裡**雙擊 `setup.bat`**。它會一步一步顯示目前在做什麼，可以重複執行（已經裝好的會跳過）：
   - 用 winget 安裝缺少的工具：**Node.js LTS**、**FFmpeg**（Gyan.FFmpeg，含 libass 與 NVENC）、**uv**（管理 Python）、**Ollama**（自動找精華）與 **Deno**（里程碑 3 才會用到）。安裝 Node.js 時可能會跳出系統管理員權限的確認視窗。
   - 確認 pnpm 是 10.5 以上的版本（10、11、12 都可以）。沒有或太舊時用 `npm install -g pnpm@10` 安裝或更新；已經裝了較新的版本會直接沿用，不會降級。
   - 安裝網頁程式的套件（`pnpm install`）與語音辨識的 Python 環境（`uv sync --project transcriber`，會自動下載 Python 3.12）。
   - 下載字幕字型 Noto Sans CJK TC 到 `fonts/`。
   - **預先下載語音辨識模型**（約 5 GB，第一次需要一段時間）。
   - **下載 Ollama 模型 qwen3.5:9b**（約 6.6 GB，`ollama pull`，會顯示下載進度；已經下載過就跳過）。Ollama 沒在執行時會自動啟動它；下載失敗不會中止安裝，最後會提醒怎麼重試。
   - 最後跑一次環境檢查（`node scripts\doctor.mjs`），列出每一項的狀態。
3. 看到「安裝完成！」就可以了。

進階用法（在專案資料夾開命令提示字元執行，兩個參數可以一起用）：

- `setup.bat -SkipOptional`：不安裝 Ollama 與 Deno（也不下載 Ollama 模型）。沒有 Ollama 時，自動找精華只會用音量。
- `setup.bat -SkipModels`：不預先下載模型。語音辨識模型第一次分析影片時才下載；Ollama 模型要之後自己執行 `ollama pull qwen3.5:9b`，在那之前自動找精華只會用音量。
- 想換 Ollama 模型（例如比較小的 `qwen3.5:4b`）：先設定環境變數 `GG_OLLAMA_MODEL`，setup.bat 會下載那個模型，gg-highlight 也會改用它。

## 啟動

**雙擊 `start.bat`**。

- 第一次啟動（或更新程式之後）會先安裝需要的套件並建置，大約 1–2 分鐘。
- 準備好之後會自動打開瀏覽器到 **http://127.0.0.1:3939**。
- 只有這台電腦能連線，同一個網路的其他裝置連不到。
- 使用期間請保持那個黑色視窗開著；**關閉視窗或按 Ctrl+C 就會停止**。
- 如果已經在執行，再雙擊 `start.bat` 只會打開瀏覽器。
- 不想自動打開瀏覽器：`start.bat --no-open`。

## 使用流程

1. **設定影片資料夾**：到「設定」加入你的錄影資料夾（例如 OBS 的錄影資料夾，可以加好幾個）。系統只會列出資料夾裡的影片檔（不含子資料夾），直接使用原檔，不會複製。
2. **加入影片**：按「加入影片」，從「影片資料夾」分頁的清單挑一支，或在「上傳檔案」分頁選擇或拖入影片檔上傳（上傳會複製一份到 `data/uploads/`）。加入時選：
   - **語言**：中文（可以中英夾雜）或英文，決定用哪個語音辨識模型。
   - **分析用音軌**：影片有好幾條音軌時，選「只有人聲」的那條辨識效果最好（見下面的 OBS 設定）。
3. **分析**：加入後會自動排隊分析（一次跑一支），步驟是讀取影片資訊 → 擷取音訊 → 語音辨識 → 準備預覽 → 分析音量與逐字稿（本機 AI 讀逐字稿）→ 找出精華片段。可以關掉網頁，分析會在背景繼續；失敗的可以按「重試」。完成的通知會寫出找到幾個候選。
4. **修正逐字稿**：分析完成後，逐字稿會切成一段一段（每段最多約兩行字幕）。點文字就能修改辨識錯的地方（時間點不能改）。改完之後新輸出的剪輯就會用新的文字。
5. **挑選候選精華片段**：到精華片段的「候選」分頁，看每個候選的精華分數與精華理由，按「選用」或「捨棄」（見下面的「自動找精華」）。
6. **新增精華片段**（自己找的）：在播放器上找到想要的段落，設定起點與終點，新增成精華片段（一開始就是「選用」）。超過 180 秒的片段會提醒「可能無法上傳成 Shorts/Reels」。
7. **輸出剪輯**：對精華片段按「輸出」，選：
   - **版型**：模糊背景（1080×1920，預設）、置中裁切（1080×1920）、原比例（最高 1080p）。
   - **燒錄字幕**：預設開啟，白字黑邊、置中偏下。
   
   輸出會排隊處理（一次一支）。完成後可以在網頁上播放，按「**下載影片**」取得 mp4，按「**下載字幕**」取得 `.srt` 字幕檔（時間從剪輯開頭算起，可以另外上傳到 YouTube 等平台）。

從影片庫移除一支影片時，會刪掉它的逐字稿、精華片段、剪輯與上傳的複本，但**絕對不會刪除影片資料夾裡的原始錄影檔**。

## 自動找精華

分析的最後兩步會自動找出**候選精華片段**，讓你決定要不要剪。

### 候選精華片段

- 依據兩種**訊號**，每秒算一次分數：
  - **音量**：聲音突然比前後幾分鐘大很多的地方（大叫、爆笑、激動的反應）。
  - **逐字稿**：本機的 Ollama（qwen3.5:9b）讀整份逐字稿，挑出好笑、失誤、逆轉、鬥嘴、過關這類段落，並寫一句理由。打招呼、閒聊、念聊天室、感謝訂閱不算。
  - 逐字稿的權重是音量的兩倍。這次缺少的訊號（例如沒有 Ollama）不扣分，只用有的訊號找；AI 有幾段逐字稿讀取失敗時，那幾段也只用音量找。影片頁會顯示「這次的候選依據」：每種訊號有沒有用到，沒用到的會寫原因與處理方法。
- 每個候選長 15–60 秒，起訖點對齊逐字稿的句子、前後各留約 1 秒；每小時影片最多約 10 個（15 分鐘的影片最多 3 個）。
- 精華片段有「全部」「**候選**」「**選用**」「**捨棄**」四個分頁。候選分頁依**精華分數**由高到低排，每個候選附**精華理由**（AI 寫的一句話；沒有 AI 理由時寫「音量突然升高，可能是大叫、爆笑或激動的反應」）；其他分頁依起點排。
- 看過之後按「**選用**」或「**捨棄**」，它就會移到對應的分頁（需要時可以改回候選）；也可以調整起訖點，或直接按「輸出」。
- 語音辨識會有錯字，AI 也可能挑錯或漏掉，所以候選只是建議；一樣可以自己新增精華片段。

### 重新分析

分析完成的影片（也包括「只重新找精華片段」失敗，或之前分析完成過、這次「重新辨識語音並找精華」失敗的影片），在影片頁按「**重新分析**」，有兩種選擇：

| 選擇 | 做什麼 | 什麼時候用 |
| --- | --- | --- |
| **只重新找精華片段** | 保留逐字稿與你的修改，只重新計算訊號與候選，幾分鐘內完成 | 改過逐字稿之後、裝好 Ollama 或下載模型之後 |
| **重新辨識語音並找精華** | 重新語音辨識，逐字稿重新產生（**你改過的文字會被覆蓋**），再找精華 | 要套用新版的逐字稿清理（例如舊影片的重複字），或辨識結果太差 |

- 預設選「只重新找精華片段」的情況：改過逐字稿、找不到原始影片檔，或上次「這次的候選依據」寫逐字稿（AI）沒有用到、原因是可以處理的（例如連不到 Ollama、沒有模型）。其他情況預設「重新辨識語音並找精華」。
- 不論哪一種，**選用、捨棄、手動新增的精華片段，以及輸出過剪輯的精華片段都會保留**；只有「還是候選、沒輸出過」的會被新的候選取代（調整過起訖點但沒按「選用」的也會被取代，想留下來請先按「選用」）。新的候選不會和保留下來的片段重疊。
- 「只重新找精華片段」排隊、執行或失敗時，逐字稿、精華片段與剪輯照常可以看、改、輸出。「重新辨識語音並找精華」排隊或執行時則和第一次分析一樣，完成前看不到逐字稿、精華片段與剪輯。
- 「重新辨識語音並找精華」失敗（或被取消）時，只要這支影片之前分析完成過，逐字稿、精華片段與剪輯都還在、照常可以看、改、輸出；畫面上方會寫「重新分析失敗」與原因，可以按「重試」（會再重新辨識一次語音，之後改過的逐字稿會被覆蓋）或「重新分析」（兩種都可以選）。這時原始影片檔也不見了的話，逐字稿與精華片段一樣可以看、改，但要把檔案放回原位置、重新整理這一頁，才能再預覽與輸出剪輯（不用按「重試」）。第一次分析就失敗的影片還沒有逐字稿，要按「重試」。
- 這支影片還有剪輯在排隊或輸出時，不能「重新辨識語音並找精華」（包括它失敗後的「重試」）；找不到原始影片檔時這個選項會停用（「重試」也會被擋下）。
- 原始影片檔不見了也可以「只重新找精華片段」：沿用上次分析的音量；連上次的音量都沒有時，這次只用逐字稿（「這次的候選依據」會寫音量沒有用到）。
- 在有自動找精華之前就分析好的**舊影片**，影片頁會提示「這支影片分析時還沒有自動找精華」：按「**找精華片段**」（等於只重新找精華片段）就好；想順便套用逐字稿清理，按「重新分析全部」。

### Ollama（AI 讀逐字稿）

- setup.bat 會用 winget 安裝 Ollama（`Ollama.Ollama`）並下載 qwen3.5:9b（約 6.6 GB）。需要 **Ollama 0.31.2 以上**（更舊的版本跑 qwen3.5 時不會照指定的格式回答）。
- Ollama 裝好之後會常駐在背景（右下角通知區有圖示）。gg-highlight 只在分析的「分析音量與逐字稿」那一步使用它（讀逐字稿），用完立刻把模型從顯示卡記憶體卸載，讓下一支影片的語音辨識有足夠的記憶體。在這一步直接關掉 start.bat 的視窗也會先卸載；萬一來不及，模型最多一分鐘後也會自己離開顯示卡。
- 8 GB 的顯示卡（例如 RTX 3060 Ti）放不下整個模型時，一小部分會在 CPU 上跑，比較慢但結果一樣。想知道的話，在分析進行到「分析音量與逐字稿」時，於命令提示字元執行 `ollama ps`，看 `PROCESSOR` 欄位（例如 `100% GPU` 或 `20%/80% CPU/GPU`）。
- 執行 `node scripts\doctor.mjs` 會檢查 Ollama 有沒有在執行、版本與模型（只是提醒，不會讓檢查失敗）。
- 不想用 AI 讀逐字稿：設定環境變數 `GG_OLLAMA_URL=off`，自動找精華只會用音量。

## OBS 多音軌設定（建議）

把「全部聲音」和「只有麥克風」錄在不同音軌，語音辨識就不會被遊戲音效干擾，剪輯又能保留完整的聲音。

1. **設定 → 輸出**，把「輸出模式」改成 **「進階」**。
2. 切到 **「錄影」** 分頁，在「音軌」勾選 **1** 和 **2**。（錄影格式建議用 mkv；錄影中斷也不會壞檔，gg-highlight 會自動處理預覽。）
3. 回到主畫面，**編輯 → 進階音訊屬性**：
   - **麥克風**：勾選音軌 **1 和 2**。
   - **桌面音效**（遊戲、音樂）：**只勾 1**。

這樣錄出來的影片：音軌 1 = 遊戲 + 人聲的混音，音軌 2 = 只有人聲。

### 音軌規則

- **分析用音軌**（加入影片時選的那條）只用在語音辨識與找精華的音量訊號。用上面的 OBS 設定時，選**音軌 2（只有人聲）**。
- **預覽與剪輯一律用音軌 1**（ffmpeg 的第一條音軌，也就是混音），所以輸出的剪輯一定有遊戲聲音和人聲。

## 疑難排解

先執行環境檢查，它會列出每一項的狀態（✅ 正常、⚠️ 提醒、❌ 需要處理）和處理方法：

```bat
node scripts\doctor.mjs
```

| 狀況 | 說明與處理 |
| --- | --- |
| 語音辨識環境顯示「CUDA 裝置 0 個」 | 找不到可用的 NVIDIA 顯示卡，語音辨識會改用 CPU，非常慢。請確認有 NVIDIA 顯示卡、到 [NVIDIA 官網](https://www.nvidia.com/Download/index.aspx) 更新驅動程式，再重新執行 doctor。所需的 CUDA 函式庫（cuBLAS）已經由 Python 環境自動安裝，不用另外裝 CUDA Toolkit。想強制用 CPU：設定環境變數 `GG_ASR_DEVICE=cpu`。 |
| NVENC 硬體編碼無法使用 | 輸出剪輯會自動改用 CPU（libx264）編碼，結果一樣只是比較慢。NVENC 偶爾失敗（例如 OBS 正在用 NVENC 錄影）時，那一次也會自動改用 CPU 重新編碼。請更新顯示卡驅動程式，並使用 setup.bat 安裝的 Gyan.FFmpeg。想強制用 CPU：`GG_VIDEO_ENCODER=libx264`。 |
| 字幕字型缺少、字幕變成方塊 | 執行 `node scripts\fetch-fonts.mjs`。下載不了的話，手動下載 [NotoSansCJKtc-Bold.otf](https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/TraditionalChinese/NotoSansCJKtc-Bold.otf) 放進專案的 `fonts\` 資料夾。 |
| 「連接埠 3939 已經被其他程式使用」 | 可能 gg-highlight 已經開著（直接用瀏覽器開 http://127.0.0.1:3939 即可），或是別的程式占用了。換一個連接埠：在命令提示字元執行 `set PORT=4000` 再執行 `start.bat`。 |
| 「這次的候選依據」顯示「連不到 Ollama」 | Ollama 沒有在執行或沒有安裝。從開始功能表打開 Ollama（沒有的話重新執行 `setup.bat`，或到 [ollama.com](https://ollama.com/download) 安裝），再對影片按「重新分析」→「只重新找精華片段」。`node scripts\doctor.mjs` 會顯示 Ollama 的狀態。 |
| 「這次的候選依據」顯示還沒有模型（「請執行 ollama pull qwen3.5:9b」） | 在命令提示字元執行 `ollama pull qwen3.5:9b`（約 6.6 GB），或重新執行 `setup.bat`；下載完再對影片按「重新分析」→「只重新找精華片段」。有設定 `GG_OLLAMA_MODEL` 的話，下載的是那個模型。 |
| 「這次的候選依據」顯示 Ollama 版本太舊 | 需要 0.31.2 以上：執行 `winget upgrade --id Ollama.Ollama`，或到 [ollama.com](https://ollama.com/download) 下載最新版，再「只重新找精華片段」。 |
| 自動找精華（AI 讀逐字稿）很慢 | AI 每次讀 10 分鐘的逐字稿，一小時的影片要讀 6–7 次。在「分析音量與逐字稿」進行中執行 `ollama ps`：`PROCESSOR` 有 CPU 的比例代表模型沒有全部放進顯示卡（8 GB 的卡很常見），會比較慢。先關掉其他吃顯示卡記憶體的程式（遊戲、OBS、瀏覽器的影片）；還是太慢的話，可以換比較小的模型：執行 `ollama pull qwen3.5:4b`，再設定環境變數 `GG_OLLAMA_MODEL=qwen3.5:4b`（找精華的品質可能差一點）。 |
| 逐字稿出現一大串重複的字（「快快快快快…」）或沒人說過的句子（「請不吝點贊 訂閱 轉發」） | 這是語音辨識在安靜或很吵的地方產生的「幻覺」。新版會在切段前自動清理：連續重複的字縮短成最多幾次（「哈哈哈」「過來過來」這類真的重複會保留），已知的幻覺句刪掉（同一段裡前後真的說話會保留），一長串一模一樣的段落只留兩段。**舊影片要「重新分析」→「重新辨識語音並找精華」才會套用**（會覆蓋你改過的逐字稿）；「只重新找精華片段」不會改逐字稿。 |
| 模型下載失敗或很慢 | 確認網路可以連到 huggingface.co，再重新執行 `setup.bat`（已下載的部分會保留）。也可以單獨下載：`uv run --project transcriber gg-transcribe download --model SoybeanMilk/faster-whisper-Breeze-ASR-25`。模型放在 `%USERPROFILE%\.cache\huggingface`，空間不夠可以設定環境變數 `HF_HOME` 換到別的磁碟。 |
| 建置失敗或畫面怪怪的 | 刪掉專案裡的 `.output` 資料夾，再雙擊 `start.bat` 重新建置；還是不行就重新執行 `setup.bat`。 |
| setup.bat 或 start.bat 在安裝套件（`pnpm install`）時失敗 | 原因在 pnpm 印出的錯誤訊息裡（通常在最後幾行）。常見的有：網路連不到套件庫（`ERR_PNPM_FETCH_…`、`ETIMEDOUT`）→ 確認網路後再試；`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` → 有套件發布還不到一天，pnpm 11 以上會先擋下，隔天再試；`EPERM`、`EBUSY` → 檔案被其他程式占用，關掉後再試；`ERR_PNPM_IGNORED_BUILDS` → 見下一列。 |
| 出現 `ERR_PNPM_IGNORED_BUILDS`（`Ignored build scripts: esbuild…`） | 舊版 gg-highlight 的設定 pnpm 11 以後讀不到，請更新到最新版再重新執行 `setup.bat`。下載 ZIP 的話，把新的 ZIP 解壓縮覆蓋原本的資料夾。用 git 的話，不要用 `git pull`（會被 pnpm 失敗時自己產生的 `pnpm-workspace.yaml`，以及舊版換行設定讓 `scripts/setup.ps1` 等檔案看起來「有本機修改」擋下），改在專案資料夾執行 `git fetch`，再執行 `git reset --hard "@{u}"`。這會丟掉對專案檔案的修改（你沒改過就沒影響）；`data\` 與 `fonts\` 不受影響。 |
| setup.bat 說 pnpm 更新後還是舊版 | 電腦裡有另一個不是用 npm 裝的 pnpm（例如 corepack 或 pnpm 官方安裝程式裝的）排在前面。訊息裡會顯示它的位置：用當初安裝它的方式更新到 10.5 以上，或移除它之後重新執行 `setup.bat`。 |
| setup.bat 說找不到 winget | 到 Microsoft Store 安裝或更新「應用程式安裝程式」（App Installer）。 |
| 命令視窗的中文變亂碼 | 改用「Windows 終端機」（Windows 11 預設）開啟，或在視窗標題列按右鍵 → 內容，把字型換成支援中文的字型。 |

## 開發者

需要 Node.js 22.13 以上、pnpm 10.5 以上（10、11、12 都可以）、ffmpeg（含 libass）、uv。

```bash
pnpm install
uv sync --project transcriber
node scripts/fetch-fonts.mjs

pnpm dev          # 開發伺服器（http://127.0.0.1:3939，修改後自動重新載入）
pnpm test         # Vitest：單元測試 + 用真的 ffmpeg / sqlite 跑的整合測試
pnpm test:e2e     # Playwright：啟動整個 app 走一次完整流程
pnpm build        # 建置到 .output/
pnpm start        # 等於 node scripts/start.mjs：需要時自動 install / build，再啟動並打開瀏覽器
```

`pnpm test:e2e`（`tests/e2e/`，設定在 `playwright.config.ts`）：

- 第一次要先下載 Playwright 的 Chromium：`npx playwright install chromium`。已經有別的 Chromium 的話，可以改用環境變數 `PW_CHROMIUM_PATH` 指定執行檔（例如 `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome pnpm test:e2e`）。
- 會自己啟動 app：原始碼有變才 `pnpm build`，再用一個暫時的資料夾、隨機連接埠、`Systran/faster-whisper-tiny`（CPU）與 `libx264` 執行 `.output/server/index.mjs`，跑完刪掉暫時資料夾。tiny 模型第一次會從 Hugging Face 下載。
- 也會啟動假的 Ollama（`server/lib/llm/test-helpers/fake-ollama.mjs`，情境 `ok`），app 的 `GG_OLLAMA_URL` 指向它，不會用到電腦上真的 Ollama；測試用 `POST $GG_E2E_OLLAMA_URL/__scenario` 切換情境（例如 `model-missing`）。
- 測試只檢查頁面與 API，不依賴瀏覽器實際播放影片（開源版的 Chromium 不能解碼 H.264／AAC，這時預覽區顯示「瀏覽器不支援這個格式」是正常的）。
- 設定 `E2E_SHOTS_DIR=<資料夾>` 會把主要頁面的全頁截圖存到那裡；失敗時的截圖與 trace 在 `test-results/`，報告用 `npx playwright show-report` 開。

pnpm 的設定放在 `pnpm-workspace.yaml`（pnpm 11 起不讀 `package.json` 的 `pnpm` 欄位）：

- 允許哪些套件在安裝時執行安裝腳本，同一份清單寫兩次：`allowBuilds`（pnpm 10.26 以上、11、12 讀這個）與 `onlyBuiltDependencies`（pnpm 10.5–10.25）。新增的套件有安裝腳本時兩邊都要加，否則 pnpm 11 以上會讓安裝失敗（`ERR_PNPM_IGNORED_BUILDS`）；`scripts/pnpm-config.test.ts` 會檢查。不要用 `pnpm approve-builds` 改這個檔案，它會刪掉 `onlyBuiltDependencies`。
- `packages: ['.']` 不能拿掉：pnpm 9 與 10.0–10.4 讀到沒有它的 `pnpm-workspace.yaml` 會直接報錯（連 `pnpm --version` 都會）。
- pnpm 11 以上安裝時會擋下 lockfile 裡發布還不到一天的版本（`minimumReleaseAge`），所以更新套件後，等新版本發布滿一天再推上去。

其他腳本：

- `node scripts/doctor.mjs [--json]`：環境檢查；`--json` 輸出機器可讀的結果。必要項目沒通過時結束代碼是 1（Ollama、NVENC 這類選用項目只會提醒）。
- `node scripts/fetch-fonts.mjs [--force] [--no-download]`：取得字幕字型（下載 → 複製系統已安裝的 Noto Sans CJK → 提示手動下載）。
- `scripts/setup.ps1`：setup.bat 呼叫的 PowerShell 安裝腳本。

環境變數（`GG_DATA_DIR`、`GG_FONTS_DIR`、`GG_FFMPEG`、`GG_FFPROBE`、`GG_TRANSCRIBER_CMD`、`GG_ASR_MODEL_ZH`、`GG_ASR_MODEL_EN`、`GG_ASR_DEVICE`、`GG_VIDEO_ENCODER`、`GG_OLLAMA_URL`、`GG_OLLAMA_MODEL`、`HOST`、`PORT`）的說明見 [docs/design.md](docs/design.md#環境變數)。`GG_OLLAMA_URL` 預設 `http://127.0.0.1:11434`，設成 `off` 就不用 AI 讀逐字稿；`GG_OLLAMA_MODEL` 預設 `qwen3.5:9b`。

Ollama 在測試裡一律用假的 HTTP 伺服器（`server/lib/llm/test-helpers/fake-ollama.mjs`，可以模擬正常、沒有模型、連不到、回應壞掉、卡住）：自己寫的測試要把 `GG_OLLAMA_URL` 指到假的伺服器或設成 `off`，不要連到真的 Ollama。真的模型效果要在有 Ollama 的電腦上確認。

設計與用語：[docs/design.md](docs/design.md)（產品行為、資料夾、API）、[GLOSSARY.md](GLOSSARY.md)（用語）、[docs/adr/](docs/adr/)（架構決定）。

## 第三方元件與授權

gg-highlight 不附帶下列元件的檔案，而是在安裝或第一次使用時從官方來源下載；使用時請遵守各自的授權。

| 元件 | 用途 | 授權 |
| --- | --- | --- |
| [Breeze-ASR-25](https://huggingface.co/MediaTek-Research/Breeze-ASR-25)（MediaTek Research；faster-whisper 版本由 [SoybeanMilk](https://huggingface.co/SoybeanMilk/faster-whisper-Breeze-ASR-25) 轉換） | 中文語音辨識模型 | Apache-2.0 |
| [Whisper large-v3-turbo](https://huggingface.co/openai/whisper-large-v3-turbo)（OpenAI；CTranslate2 版本由 [deepdml](https://huggingface.co/deepdml/faster-whisper-large-v3-turbo-ct2) 轉換） | 英文語音辨識模型 | MIT |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper)、[CTranslate2](https://github.com/OpenNMT/CTranslate2) | 語音辨識引擎 | MIT |
| [Noto Sans CJK](https://github.com/notofonts/noto-cjk) | 字幕字型 | SIL Open Font License 1.1 |
| [FFmpeg](https://ffmpeg.org/)（Windows 版由 [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) 建置） | 影片處理、字幕燒錄、編碼 | LGPL-2.1+；含 libx264 等元件的建置為 GPL |
| [OpenCC](https://github.com/BYVoid/OpenCC)（[opencc-js](https://github.com/nk2028/opencc-js)） | 簡體轉台灣正體 | Apache-2.0（opencc-js 為 MIT） |
| [Qwen3.5-9B](https://huggingface.co/Qwen/Qwen3.5-9B)（Alibaba Qwen；由 Ollama 的 [qwen3.5](https://ollama.com/library/qwen3.5) 下載） | 讀逐字稿找精華的本機 AI 模型 | Apache-2.0 |
| Node.js、Nuxt、uv、Ollama、Deno | 執行環境與工具 | 各自的開源授權（MIT／Apache-2.0 等） |

## 關於 YouTube（里程碑 3）

之後的 YouTube 功能會用 yt-dlp 下載影片與聊天室資料，僅供個人剪輯**自己擁有或已取得授權**的內容。下載與重新發布他人的影片可能違反 YouTube 服務條款與著作權法，請自行確認你有權使用這些內容。
