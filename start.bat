@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [錯誤] 找不到 Node.js。
  echo 請先在這個資料夾雙擊 setup.bat 安裝需要的工具，裝好後再雙擊 start.bat。
  echo.
  pause
  exit /b 1
)

node scripts\start.mjs %*
if errorlevel 1 (
  echo.
  echo gg-highlight 沒有正常結束，請看上面的訊息。
  echo 可以執行 node scripts\doctor.mjs 檢查環境。
  pause
  exit /b 1
)
