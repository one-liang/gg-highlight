#Requires -Version 5.1
<#
  gg-highlight 一鍵安裝（Windows PowerShell 5.1 相容）。由 setup.bat 呼叫。
  可以重複執行：已經裝好的東西會自動跳過。

  參數：
    -SkipOptional  不安裝 Ollama（自動找精華）與 Deno（里程碑 3 才會用到）
    -SkipModels    不預先下載模型：語音辨識模型第一次分析時才下載；
                   Ollama 模型（qwen3.5:9b，約 6.6 GB）之後要自己執行 ollama pull

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
# Without this, the corepack pnpm shim may wait on a hidden Y/n download prompt while we read the pnpm version.
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'

$Root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $Root

# node:sqlite loads without a flag only from 22.13 on.
$MinNodeVersion = [version]'22.13.0'
# Oldest pnpm that reads the build approvals in pnpm-workspace.yaml. Same as MIN_PNPM_VERSION in scripts/lib/common.mjs.
$MinPnpmVersion = [version]'10.5.0'
# Default Ollama model for the transcript signal. Same as DEFAULT_OLLAMA_MODEL in server/lib/llm/types.ts and scripts/doctor.mjs.
$DefaultOllamaModel = 'qwen3.5:9b'
$DefaultOllamaModelSize = '約 6.6 GB'
$AsrModels = @(
  @{ Id = 'SoybeanMilk/faster-whisper-Breeze-ASR-25'; Name = '中文模型 Breeze-ASR-25（約 3 GB）' },
  @{ Id = 'deepdml/faster-whisper-large-v3-turbo-ct2'; Name = '英文模型 Whisper large-v3-turbo（約 1.6 GB）' }
)
$Tools = @(
  @{ Name = 'Node.js'; Id = 'OpenJS.NodeJS.LTS'; Commands = @('node'); Optional = $false },
  @{ Name = 'FFmpeg'; Id = 'Gyan.FFmpeg'; Commands = @('ffmpeg', 'ffprobe'); Optional = $false },
  @{ Name = 'uv（Python 環境管理）'; Id = 'astral-sh.uv'; Commands = @('uv'); Optional = $false },
  @{ Name = 'Ollama（自動找精華）'; Id = 'Ollama.Ollama'; Commands = @('ollama'); Optional = $true; Later = '沒有 Ollama 時，自動找精華只會用音量；之後可以重新執行 setup.bat，或到 https://ollama.com/download 安裝。' },
  @{ Name = 'Deno（里程碑 3：YouTube）'; Id = 'DenoLand.Deno'; Commands = @('deno'); Optional = $true; Later = '現在還用不到，可以之後再裝。' }
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

function Stop-Setup([string]$Text, [string[]]$Details = @()) {
  Write-Host ''
  Write-Host ('安裝中止：' + $Text) -ForegroundColor Red
  foreach ($line in $Details) {
    Write-Host ('  ' + $line)
  }
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

# Version of the pnpm on PATH, or $null when there is none or it cannot run (a broken shim counts as missing).
function Get-PnpmVersion {
  if (-not (Test-Command 'pnpm')) { return $null }
  $raw = & pnpm --version 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  if ("$raw" -match '(\d+)\.(\d+)\.(\d+)') {
    return [version]('{0}.{1}.{2}' -f $Matches[1], $Matches[2], $Matches[3])
  }
  return $null
}

function Get-PnpmPath {
  $found = Get-Command 'pnpm' -ErrorAction SilentlyContinue
  if ($null -eq $found) { return '' }
  return [string]$found.Source
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

# Ollama model names default to the latest tag: qwen3 and qwen3:latest are the same model.
function Get-OllamaModelKey([string]$Name) {
  $key = "$Name".Trim().ToLowerInvariant()
  $lastPart = $key.Substring($key.LastIndexOf('/') + 1)
  if ($lastPart.Contains(':')) { return $key }
  return $key + ':latest'
}

# True when the first column of ollama list names the model. Like ollama pull, ollama list starts the Ollama app when it is not running.
function Test-OllamaModel([string]$Model) {
  $wanted = Get-OllamaModelKey $Model
  $lines = & ollama list 2>$null
  if ($LASTEXITCODE -ne 0) { return $false }
  foreach ($line in @($lines)) {
    $name = ("$line".Trim() -split '\s+')[0]
    if ($name -and ((Get-OllamaModelKey $name) -eq $wanted)) { return $true }
  }
  return $false
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
      Add-Note ('找不到 winget，沒有安裝 ' + $tool.Name + '。' + $tool.Later)
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
    Add-Note ($tool.Name + ' 沒有安裝成功（winget 代碼 ' + $wingetCode + '）。' + $tool.Later)
    continue
  }
  if ($tool.Id -eq 'OpenJS.NodeJS.LTS' -and (Test-Command 'node')) {
    Stop-Setup ('Node.js 版本太舊，需要 ' + $MinNodeVersion + ' 以上。請到 https://nodejs.org 下載 LTS 版安裝後，重新執行 setup.bat。')
  }
  Stop-Setup ($tool.Name + ' 安裝失敗（winget 代碼 ' + $wingetCode + '）。請關閉這個視窗後重新執行 setup.bat；還是不行的話，請手動執行：winget install --id ' + $tool.Id + ' --exact')
}

# ---- 3. pnpm ----
# A pnpm that is new enough is kept as it is (pnpm 11 and 12 work too): never downgrade it.
# A missing, broken or too old pnpm gets the newest pnpm 10.
Write-Step '檢查 pnpm'
$pnpmVersion = Get-PnpmVersion
if (($null -ne $pnpmVersion) -and ($pnpmVersion -ge $MinPnpmVersion)) {
  Write-Ok ('pnpm ' + $pnpmVersion + ' 已安裝')
}
else {
  if ($null -eq $pnpmVersion) {
    Write-Info '安裝 pnpm（npm install -g pnpm@10）…'
  }
  else {
    Write-Info ('pnpm ' + $pnpmVersion + ' 太舊，需要 ' + $MinPnpmVersion + ' 以上，更新中（npm install -g pnpm@10）…')
  }
  & npm install -g pnpm@10
  Update-SessionPath
  if (-not (Test-Command 'pnpm')) {
    $npmPrefix = & npm prefix -g 2>$null
    if ($npmPrefix) { $env:Path = $env:Path + ';' + "$npmPrefix".Trim() }
  }
  $pnpmVersion = Get-PnpmVersion
  if ($null -eq $pnpmVersion) {
    $pnpmPath = Get-PnpmPath
    if ($pnpmPath) {
      Stop-Setup ('找到 pnpm（' + $pnpmPath + '），但無法執行。請關閉這個視窗後重新執行 setup.bat；還是不行的話，請手動執行：npm install -g pnpm@10')
    }
    Stop-Setup 'pnpm 安裝失敗。請關閉這個視窗後重新執行 setup.bat；還是不行的話，請手動執行：npm install -g pnpm@10'
  }
  if ($pnpmVersion -lt $MinPnpmVersion) {
    # Another pnpm (corepack, the standalone installer) comes before the one from npm on PATH.
    Stop-Setup ('更新後找到的 pnpm 還是 ' + $pnpmVersion + '（' + (Get-PnpmPath) + '），需要 ' + $MinPnpmVersion + ' 以上。這個 pnpm 不是用 npm 裝的（例如 corepack 或 pnpm 官方安裝程式），請用當初安裝它的方式更新到 ' + $MinPnpmVersion + ' 以上，或移除它之後重新執行 setup.bat。')
  }
  Write-Ok ('pnpm ' + $pnpmVersion + ' 安裝完成')
}

# ---- 4. Web app packages ----
Write-Step '安裝網頁程式的套件（pnpm install）'
# confirm-modules-purge=false: node_modules made by another pnpm major is rebuilt instead of asking Y/n.
& pnpm install --config.confirm-modules-purge=false
if ($LASTEXITCODE -ne 0) {
  # pnpm printed the real error just above; list the common causes instead of guessing one.
  Stop-Setup 'pnpm install 失敗，原因請看上面 pnpm 印出的錯誤訊息（通常在最後幾行）。' @(
    '常見原因：',
    '- 網路連不到套件庫（ERR_PNPM_FETCH_…、ETIMEDOUT、ECONNRESET、ENOTFOUND）：確認網路連線後再試一次。',
    '- 檔案被其他程式占用（EPERM、EBUSY）：關掉正在執行的 gg-highlight 和其他開著這個資料夾裡檔案的程式後再試一次。',
    '- ERR_PNPM_IGNORED_BUILDS（套件的安裝腳本被 pnpm 擋下）：請更新到最新版的 gg-highlight 再試（README 的「疑難排解」有說明）。',
    '- ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION（有套件發布還不到一天，pnpm 11 以上會先擋下）：隔天再試一次。',
    '處理後重新執行 setup.bat；也可以執行 node scripts\doctor.mjs 檢查環境。'
  )
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

# ---- 8. Ollama model ----
# Optional: without Ollama or its model, the transcript signal is missing and highlights use loudness only.
$OllamaModel = $DefaultOllamaModel
if ($env:GG_OLLAMA_MODEL -and ("$env:GG_OLLAMA_MODEL".Trim().Length -gt 0)) { $OllamaModel = "$env:GG_OLLAMA_MODEL".Trim() }
$OllamaSize = ''
if ($OllamaModel -eq $DefaultOllamaModel) { $OllamaSize = '（' + $DefaultOllamaModelSize + '）' }
$OllamaUrl = "$env:GG_OLLAMA_URL".Trim()
Write-Step ('準備自動找精華用的 AI 模型（Ollama：' + $OllamaModel + '）')
if ($OllamaUrl -eq 'off') {
  Write-Info '已用 GG_OLLAMA_URL=off 關閉 AI 讀逐字稿，略過。自動找精華只會用音量。'
}
elseif ($SkipOptional) {
  if (Test-Command 'ollama') {
    Write-Info '略過檢查 Ollama 模型（-SkipOptional）。'
  }
  else {
    Add-Note '沒有安裝 Ollama（-SkipOptional）：自動找精華只會用音量，直到安裝 Ollama 為止。想用的話，重新執行 setup.bat（不加 -SkipOptional）。'
  }
}
elseif (-not (Test-Command 'ollama')) {
  # The winget step already added a note about why Ollama is missing.
  Write-Info '沒有 Ollama，略過下載模型。在安裝 Ollama 之前，自動找精華只會用音量；裝好之後重新執行 setup.bat 即可。'
}
elseif ($SkipModels) {
  Write-Info ('略過下載（-SkipModels）。需要時請在命令提示字元執行：ollama pull ' + $OllamaModel + $OllamaSize)
  Write-Info '下載之前，自動找精華只會用音量。'
}
else {
  # The ollama CLI talks to OLLAMA_HOST; point it at the same server the app uses.
  if ($OllamaUrl.Length -gt 0) { $env:OLLAMA_HOST = $OllamaUrl }
  if (Test-OllamaModel $OllamaModel) {
    Write-Ok ($OllamaModel + ' 已下載')
  }
  else {
    Write-Info ('下載 ' + $OllamaModel + $OllamaSize + '，只有第一次需要，請耐心等候（ollama pull ' + $OllamaModel + '）…')
    & ollama pull $OllamaModel
    $pullCode = $LASTEXITCODE
    if ($pullCode -eq 0) {
      Write-Ok ($OllamaModel + ' 已就緒')
    }
    else {
      Add-Note ('Ollama 模型 ' + $OllamaModel + ' 沒有下載成功（ollama 代碼 ' + $pullCode + '）。自動找精華會先只用音量。請從開始功能表打開 Ollama、確認網路連線後，在命令提示字元執行 ollama pull ' + $OllamaModel + '，或重新執行 setup.bat。')
    }
  }
}

# ---- 9. Final check ----
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
