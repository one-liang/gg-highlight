# gg-highlight

個人自用的影片精華工具：從一支影片找出值得剪的段落，剪成帶字幕的短影片。

## Language

**原始影片（Source Video）**:
使用者交給系統分析的一支影片，來源是本機檔案或一個 YouTube 連結。
_Avoid_: 素材、原片、input video

**精華片段（Highlight）**:
原始影片中值得剪出來的一段時間區間，只有起點與終點，本身不是影片檔。
_Avoid_: 片段、高光、highlight clip

**剪輯（Clip）**:
把一個精華片段輸出成的影片檔，可帶有燒錄在畫面上的字幕。
_Avoid_: 短片、輸出檔、export

**逐字稿（Transcript）**:
一支原始影片中所有說話內容的文字與對應時間點，每支原始影片一份。
_Avoid_: 辨識結果、ASR 結果

**字幕（Subtitle）**:
剪輯畫面上顯示的文字，內容是逐字稿中落在該精華片段時間範圍內的部分。
_Avoid_: caption
