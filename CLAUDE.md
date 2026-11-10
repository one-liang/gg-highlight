# gg-highlight

## 專案目標

一個以免費、可自架為主的影片處理工具：

- **輸入**：上傳本機影片檔，或貼上 YouTube 連結
- **Highlight 分析**：自動找出影片中的精彩片段
- **裁剪**：把 highlight 片段剪下來輸出
- **自動字幕**：辨識影片中的說話內容，轉成字幕並顯示在畫面上
- **原則**：優先選用免費、可在本機自行執行的工具與模型，避免依賴付費 API

## Agent skills

### Issue tracker

Issue 與 spec 放在 GitHub Issues（`one-liang/gg-highlight`）。詳見 `docs/agents/issue-tracker.md`。

### Triage labels

使用預設五個標籤：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。詳見 `docs/agents/triage-labels.md`。

### Domain docs

Single-context：repo 根目錄放一個 `GLOSSARY.md`，ADR 放 `docs/adr/`。詳見 `docs/agents/domain.md`。
