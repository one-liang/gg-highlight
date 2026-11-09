# 用本機 Ollama＋Qwen 讀逐字稿找精華

「逐字稿內容」是判斷遊戲實況哪裡精彩最有用的訊號，但要免費、在使用者自己的電腦上執行（RTX 3060 Ti 8GB）。因此由 Nuxt 透過 HTTP 呼叫本機 Ollama，預設模型 `qwen3.5:9b`（Q4_K_M，約 6.6GB；比當初討論的 qwen3:8b 新一代，16k context 的 KV cache 約 0.5GB，qwen3:8b 約 2.25GB），用 structured outputs（`format` 給 JSON schema）要求回傳「行號範圍＋1–10 分＋一句理由」，時間換算、對齊句子、合併都在 TypeScript 裡做。

## Considered Options

- **雲端 LLM API（Gemini、OpenAI 等）**：違反「免費、可本機執行」的原則，影片內容也會離開使用者的電腦。
- **qwen3:8b**：一年多前的上一代，16k context 時顯示卡記憶體更吃緊。`GG_OLLAMA_MODEL` 可以換回去或換成更小的 `qwen3.5:4b`。
- **在 Python 轉錄程式裡跑 LLM（transformers／llama-cpp-python）**：要多管一套 CUDA 相依，而且語音辨識與 LLM 會搶同一張顯示卡；Ollama 自己管模型下載、量化與 GPU/CPU 分配，Windows 有安裝程式（winget `Ollama.Ollama`）。
- **要模型直接回傳秒數**：小模型抄時間點常出錯，時間戳也多佔約 4 倍的 token；改成編號的行，再由程式換成時間。

## Consequences

- 需要 Ollama 0.31.2 以上（`qwen3.5` 在 `think: false` 時 `format` 被忽略的問題在這版修好）；`qwen3.5` 預設會「思考」，所以一定要送 `think: false`，也要覆寫它預設的 `temperature 1`、`presence_penalty 1.5`。
- 8GB 顯示卡上 Ollama 預設 context 只有 4096，所以每次都送 `num_ctx 16384`（每次相同，避免重新載入）。模型連同視覺投影層可能放不進顯示卡，少部分層會跑在 CPU，比較慢但能跑。
- 語音辨識與 LLM 不能同時佔用顯示卡：分析一次一支，LLM 用完立刻卸載（`keep_alive: 0`）。
- Ollama 沒裝、沒啟動或沒有模型時，逐字稿訊號標成 `missing`，分析照常用音量完成（缺少的訊號不扣分），影片頁與設定頁說明怎麼補上。
- 雲端開發環境不能執行 Ollama，測試一律用假的 Ollama HTTP 伺服器；真實模型的品質要在使用者的電腦上確認，提示詞與門檻之後可能要依實際結果調整。
