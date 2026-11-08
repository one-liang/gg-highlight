#Requires -Version 5.1
<#
  gg-highlight 一鍵安裝（Windows PowerShell 5.1 相容）。由 setup.bat 呼叫。
  可以重複執行：已經裝好的東西會自動跳過。

  參數：
    -SkipOptional  不安裝 Ollama 與 Deno（里程碑 2、3 才會用到）
    -SkipModels    不預先下載語音辨識模型（第一次分析時才下載）

  This file must stay UTF-8 *with BOM*, or Windows PowerShell 5.1 reads the Chinese text as ANSI.
#>
[CmdletBinding()]
param(
  [switch]$SkipOptional,
  [switch]$SkipModels
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $Root

$MinNodeVersion = [version]'22.12.0'
$AsrModels = @(
  @{ Id = 'SoybeanMilk/faster-whisper-Breeze-ASR-25'; Name = '中文模型 Breeze-ASR-25（約 3 GB）' },
  @{ Id = 'deepdml/faster-whisper-large-v3-turbo-ct2'; Name = '英文模型 Whisper large-v3-turbo（約 1.6 GB）' }
)
$Tools = @(
  @{ Name = 'Node.js'; Id = 'OpenJS.NodeJS.LTS'; Commands = @('node'); Optional = $false },
  @{ Name = 'FFmpeg'; Id = 'Gyan.FFmpeg'; Commands = @('ffmpeg', 'ffprobe'); Optional = $false },
  @{ Name = 'uv（Python 環境管理）'; Id = 'astral-sh.uv'; Commands = @('uv'); Optional = $false },
  @{ Name = 'Ollama（里程碑 2：自動找精華）'; Id = 'Ollama.Ollama'; Commands = @('ollama'); Optional = $true },
  @{ Name = 'Deno（里程碑 3：YouTube）'; Id = 'DenoLand.Deno'; Commands = @('deno'); Optional = $true }
)

$script:StepNumber = 0
$script:Notes = New-Object System.Collections.Generic.List[string]
$script:LastPercent = -1

function Write-Step([string]$Text) {
  $script:StepNumber = $script:StepNumber + 1
  Write-Host ''
  Write-Host ('[{0}] {1}' -f $script:StepNumber, $Text) -ForegroundColor Cyan
}

function Write-Ok([string]$Text) {
  Write-Host ('    OK  ' + $Text) -ForegroundColor Green
}

function Write-Info([string]$Text) {
  Write-Host ('    ' + $Text)
}

function Add-Note([string]$Text) {
  $script:Notes.Add($Text)
  Write-Host ('    注意：' + $Text) -ForegroundColor Yellow
}

function Stop-Setup([string]$Text) {
  Write-Host ''
  Write-Host ('安裝中止：' + $Text) -ForegroundColor Red
  exit 1
}

# Reloads PATH from the registry so tools installed a moment ago can be found in this window.
function Update-SessionPath {
  $parts = @()
  foreach ($scope in @('Machine', 'User')) {
    $value = [Environment]::GetEnvironmentVariable('Path', $scope)
    if ($value) { $parts += $value }
  }
  if ($parts.Count -gt 0) { $env:Path = $parts -join ';' }
}

function Test-Command([string]$Name) {
  $found = Get-Command $Name -ErrorAction SilentlyContinue
  return ($null -ne $found)
}

function Get-NodeVersion {
  if (-not (Test-Command 'node')) { return $null }
  $raw = & node --version 2>$null
  if ("$raw" -match '(\d+)\.(\d+)\.(\d+)') {
    return [version]('{0}.{1}.{2}' -f $Matches[1], $Matches[2], $Matches[3])
  }
  return $null
}

function Test-ToolReady($Tool) {
  foreach ($name in $Tool.Commands) {
    if (-not (Test-Command $name)) { return $false }
  }
  if ($Tool.Id -eq 'OpenJS.NodeJS.LTS') {
    $version = Get-NodeVersion
    if ($null -eq $version) { return $false }
    if ($version -lt $MinNodeVersion) { return $false }
  }
  return $true
}

# Prints the JSON-lines events of `gg-transcribe download` in a readable way.
function Show-TranscriberLine([string]$Line) {
  $text = "$Line".Trim()
  if ($text.Length -eq 0) { return }
  $evt = $null
  if ($text.StartsWith('{')) {
    try { $evt = $text | ConvertFrom-Json } catch { $evt = $null }
  }
  if ($null -eq $evt) {
    Write-Host ('    ' + $text)
    return
  }
  if ($evt.type -eq 'progress') {
    $percent = [int][math]::Floor([double]$evt.progress * 100)
    if (($percent -ge ($script:LastPercent + 10)) -or (($percent -eq 100) -and ($script:LastPercent -lt 100))) {
      $script:LastPercent = $percent
      Write-Host ('    下載進度 {0}%' -f $percent)
    }
  }
  elseif ($evt.type -eq 'log') {
    Write-Host ('    ' + $evt.message)
  }
  elseif ($evt.type -eq 'error') {
    Write-Host ('    錯誤：' + $evt.message) -ForegroundColor Red
  }
}

Write-Host '=================================================='
Write-Host ' gg-highlight 安裝程式'
Write-Host ' 可以重複執行：已經裝好的東西會自動跳過。'
Write-Host (' 安裝位置：' + $Root)
Write-Host '=================================================='

Update-SessionPath

# ---- 1. NVIDIA driver (warning only) ----
Write-Step '檢查 NVIDIA 顯示卡驅動程式'
if (Test-Command 'nvidia-smi') {
  $gpu = & nvidia-smi '--query-gpu=name,driver_version' '--format=csv,noheader' 2>$null
  if ($LASTEXITCODE -eq 0 -and $gpu) {
    Write-Ok ('找到顯示卡：' + (($gpu | ForEach-Object { "$_".Trim() }) -join '；'))
  }
  else {
    Add-Note 'nvidia-smi 沒有偵測到顯示卡。語音辨識與輸出剪輯會改用 CPU，速度比較慢。'
  }
}
else {
  Add-Note '找不到 nvidia-smi。如果有 NVIDIA 顯示卡，請到 https://www.nvidia.com/Download/index.aspx 安裝最新驅動程式；沒有的話語音辨識與輸出剪輯會用 CPU，比較慢。'
}

# ---- 2. Tools via winget ----
Write-Step '檢查並安裝需要的工具（winget）'
$hasWinget = Test-Command 'winget'
foreach ($tool in $Tools) {
  if ($tool.Optional -and $SkipOptional) {
    Write-Info ('略過 ' + $tool.Name + '（-SkipOptional）')
    continue
  }
  if (Test-ToolReady $tool) {
    Write-Ok ($tool.Name + ' 已安裝')
    continue
  }
  if (-not $hasWinget) {
    if ($tool.Optional) {
      Add-Note ('找不到 winget，沒有安裝 ' + $tool.Name + '。現在還用不到，可以之後再裝。')
      continue
    }
    Stop-Setup ('需要安裝 ' + $tool.Name + '，但找不到 winget。請到 Microsoft Store 安裝或更新「應用程式安裝程式」（App Installer），再重新執行 setup.bat。')
  }

  Write-Info ('安裝 ' + $tool.Name + '（winget：' + $tool.Id + '），可能會跳出系統管理員權限的確認視窗…')
  & winget install --id $tool.Id --exact --silent --accept-package-agreements --accept-source-agreements
  $wingetCode = $LASTEXITCODE
  Update-SessionPath

  if (Test-ToolReady $tool) {
    Write-Ok ($tool.Name + ' 安裝完成')
    continue
  }
  if ($tool.Optional) {
    Add-Note ($tool.Name + ' 沒有安裝成功（winget 代碼 ' + $wingetCode + '）。現在還用不到，可以之後再裝。')
    continue
  }
  if ($tool.Id -eq 'OpenJS.NodeJS.LTS' -and (Test-Command 'node')) {
    Stop-Setup ('Node.js 版本太舊，需要 ' + $MinNodeVersion + ' 以上。請到 https://nodejs.org 下載 LTS 版安裝後，重新執行 setup.bat。')
  }
  Stop-Setup ($tool.Name + ' 安裝失敗（winget 代碼 ' + $wingetCode + '）。請關閉這個視窗後重新執行 setup.bat；還是不行的話，請手動執行：winget install --id ' + $tool.Id + ' --exact')
}

# ---- 3. pnpm ----
Write-Step '檢查 pnpm'
if (Test-Command 'pnpm') {
  Write-Ok 'pnpm 已安裝'
}
else {
  Write-Info '安裝 pnpm（npm install -g pnpm@10）…'
  & npm install -g pnpm@10
  Update-SessionPath
  if (-not (Test-Command 'pnpm')) {
    $npmPrefix = & npm prefix -g 2>$null
    if ($npmPrefix) { $env:Path = $env:Path + ';' + "$npmPrefix".Trim() }
  }
  if (-not (Test-Command 'pnpm')) {
    Stop-Setup 'pnpm 安裝失敗。請關閉這個視窗後重新執行 setup.bat；還是不行的話，請手動執行：npm install -g pnpm@10'
  }
  Write-Ok 'pnpm 安裝完成'
}

# ---- 4. Web app packages ----
Write-Step '安裝網頁程式的套件（pnpm install）'
& pnpm install
if ($LASTEXITCODE -ne 0) {
  Stop-Setup 'pnpm install 失敗。請確認網路連線後重新執行 setup.bat。'
}
Write-Ok '套件安裝完成'

# ---- 5. Python transcriber ----
Write-Step '安裝語音辨識環境（uv sync --project transcriber）'
& uv sync --project transcriber
if ($LASTEXITCODE -ne 0) {
  Stop-Setup '語音辨識環境安裝失敗。請確認網路連線後重新執行 setup.bat。'
}
Write-Ok '語音辨識環境安裝完成'

# ---- 6. Subtitle font ----
Write-Step '準備字幕字型（Noto Sans CJK TC）'
& node (Join-Path $Root 'scripts\fetch-fonts.mjs')
if ($LASTEXITCODE -ne 0) {
  Add-Note '字幕字型還沒準備好，燒錄的字幕可能無法顯示中文。請照上面的說明手動下載。'
}

# ---- 7. ASR models ----
if ($SkipModels) {
  Write-Step '略過預先下載語音辨識模型（-SkipModels）'
  Write-Info '第一次分析影片時會自動下載。'
}
else {
  Write-Step '預先下載語音辨識模型（只有第一次需要，檔案很大，請耐心等候）'
  foreach ($model in $AsrModels) {
    Write-Info ('下載' + $model.Name + '：' + $model.Id)
    $script:LastPercent = -1
    & uv run --project transcriber gg-transcribe download --model $model.Id | ForEach-Object { Show-TranscriberLine $_ }
    if ($LASTEXITCODE -ne 0) {
      Add-Note ($model.Name + ' 下載失敗；第一次分析影片時會再自動下載。')
    }
    else {
      Write-Ok ($model.Name + ' 已就緒')
    }
  }
}

# ---- 8. Final check ----
Write-Step '最後檢查環境（node scripts\doctor.mjs）'
& node (Join-Path $Root 'scripts\doctor.mjs')
$doctorCode = $LASTEXITCODE

Write-Host ''
if ($script:Notes.Count -gt 0) {
  Write-Host '需要注意的事項：' -ForegroundColor Yellow
  foreach ($note in $script:Notes) {
    Write-Host (' - ' + $note) -ForegroundColor Yellow
  }
  Write-Host ''
}
if ($doctorCode -eq 0) {
  Write-Host '安裝完成！之後雙擊 start.bat 就能啟動 gg-highlight。' -ForegroundColor Green
}
else {
  Write-Host '安裝步驟跑完了，但環境檢查還有沒通過的項目。請照上面的說明處理後，再執行一次 setup.bat。' -ForegroundColor Yellow
}
exit $doctorCode
