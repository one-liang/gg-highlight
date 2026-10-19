# Nuxt 全端，Python 只負責轉錄

這個工具要免費、在使用者自己的 Windows 電腦上執行，使用者熟悉的是 Vue／Nuxt／TypeScript；但台灣中文語音辨識目前最合適的免費模型（Breeze-ASR-25 搭配 faster-whisper）在 Python 生態最成熟。因此由 Nuxt（TypeScript）負責介面、API、SQLite、分析排隊，以及呼叫 yt-dlp、ffmpeg、Ollama；Python 只有一支由 Nuxt 呼叫的轉錄程式，輸入音訊、輸出逐字稿 JSON。

## Considered Options

- **Nuxt 前端 + FastAPI 後端**：大部分後端邏輯得用使用者不熟的 Python 寫，還要多維護一個常駐服務。
- **全部 TypeScript**（whisper.cpp 的 Node 套件跑 Breeze 的 GGML 版本）：whisper.cpp 的字詞時間點到 v1.9.5（2026-10）仍標示為實驗性功能，而字幕切句與精華片段對齊句子邊界都依賴它。
- **Fork OpenShorts**：它預設依賴 Gemini，改用 Ollama 只取代挑精華的那一步，前端又是 React；拆改的成本不比自己寫低。

## Consequences

Windows 上要同時安裝 Node.js 與 Python（由 uv 管理）。Nuxt 與 Python 之間唯一的約定是「音訊檔進、逐字稿 JSON 出」，之後要換成 Qwen3-ASR 等其他模型時只需改 Python 這一側。
