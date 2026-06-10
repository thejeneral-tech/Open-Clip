# StoryVault Video Factory — desktop launcher (TrendVault-themed).
# Pure Windows PowerShell + WinForms — needs nothing pre-installed to run itself.
# Tabs: Launch (per-service cards + console), Settings, About. The Install button
# fetches everything the app needs: Node.js, FFmpeg, npm packages.

# --- hide the host console window so only the GUI shows -----------------------
try {
  $win = Add-Type -Name W -Namespace N -PassThru -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);
'@
  $win::ShowWindow($win::GetConsoleWindow(), 0) | Out-Null
} catch { }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$Root    = $PSScriptRoot
$BinNode = Join-Path $Root 'bin\node'
$BinFf   = Join-Path $Root 'bin\ffmpeg'
$LogDir  = Join-Path $Root 'data\logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$OutLog  = Join-Path $LogDir 'launcher-server.out.log'
$ErrLog  = Join-Path $LogDir 'launcher-server.err.log'
$FishOut = Join-Path $LogDir 'fish-server.out.log'
$FishErr = Join-Path $LogDir 'fish-server.err.log'
$CfgFile = Join-Path $Root 'data\launcher-config.json'

$script:ServerProc = $null
$script:FishProc   = $null
$script:NodeExe    = $null
$script:FfmpegExe  = $null
$script:FfprobeExe = $null
$script:OutPos     = 0
$script:ErrPos     = 0
$script:FishOutPos = 0
$script:FishErrPos = 0
$script:procQueue  = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()

# ============================== theme (TrendVault dark) ======================
$c_bg       = [System.Drawing.Color]::FromArgb(40,44,52)    # #282c34
$c_surface  = [System.Drawing.Color]::FromArgb(33,37,43)    # #21252b
$c_surface2 = [System.Drawing.Color]::FromArgb(44,49,60)    # #2c313c
$c_surface3 = [System.Drawing.Color]::FromArgb(27,30,36)    # #1b1e24
$c_border   = [System.Drawing.Color]::FromArgb(53,90,102)   # #355a66
$c_text     = [System.Drawing.Color]::FromArgb(156,222,242) # #9cdef2
$c_muted    = [System.Drawing.Color]::FromArgb(107,138,148) # #6b8a94
$c_acc      = [System.Drawing.Color]::FromArgb(224,108,117) # #e06c75 coral
$c_acc2     = [System.Drawing.Color]::FromArgb(235,138,145) # #eb8a91
$c_gold     = [System.Drawing.Color]::FromArgb(209,154,102) # #d19a66
$c_ok       = [System.Drawing.Color]::FromArgb(80,250,123)  # #50fa7b
$c_err      = [System.Drawing.Color]::FromArgb(255,91,91)   # #ff5b5b
$c_warn     = [System.Drawing.Color]::FromArgb(240,173,78)  # #f0ad4e

# ============================== config =======================================
$script:cfg = @{
  llmUrl       = 'http://localhost:11434/v1'
  fishUrl      = 'http://127.0.0.1:8080'
  fishModelDir = (Join-Path $Root 'data\models\s2-pro-gguf')
  fishBin      = ''
  port         = '4400'
  authEnabled  = $true
}
function Load-Cfg {
  if (Test-Path $CfgFile) {
    try {
      $j = Get-Content $CfgFile -Raw | ConvertFrom-Json
      foreach ($k in @('llmUrl','fishUrl','fishModelDir','fishBin','port')) { if ($null -ne $j.$k) { $script:cfg[$k] = [string]$j.$k } }
      if ($null -ne $j.authEnabled) { $script:cfg.authEnabled = [bool]$j.authEnabled }
    } catch { }
  }
}
function Save-Cfg {
  try { ($script:cfg | ConvertTo-Json) | Set-Content -Path $CfgFile -Encoding utf8 } catch { }
  Write-EnvFile
}
function Write-EnvFile {
  $lines = @()
  if ($script:FfmpegExe)  { $lines += "FFMPEG_PATH=$($script:FfmpegExe)" }
  if ($script:FfprobeExe) { $lines += "FFPROBE_PATH=$($script:FfprobeExe)" }
  $lines += "PORT=$($script:cfg.port)"
  $lines += "LOCAL_LLM_URL=$($script:cfg.llmUrl)"
  $lines += "FISH_TTS_URL=$($script:cfg.fishUrl)"
  if ($script:cfg.fishModelDir) { $lines += "FISH_MODEL_DIR=$($script:cfg.fishModelDir)" }
  if ($script:cfg.fishBin)      { $lines += "FISH_S2_BIN=$($script:cfg.fishBin)" }
  $authVal = if ($script:cfg.authEnabled) { 'true' } else { 'false' }
  $lines += "AUTH_ENABLED=$authVal"
  try { Set-Content -Path (Join-Path $Root '.env') -Value $lines -Encoding utf8 } catch { }
}
Load-Cfg

# ============================== window =======================================
$form = New-Object System.Windows.Forms.Form
$form.Text = 'StoryVault Launcher'
$form.Size = New-Object System.Drawing.Size(1000, 720)
$form.StartPosition = 'CenterScreen'
$form.BackColor = $c_bg
$form.ForeColor = $c_text
$form.Font = New-Object System.Drawing.Font('Consolas', 9.5)
$form.MinimumSize = New-Object System.Drawing.Size(840, 600)

# --- header ---
$header = New-Object System.Windows.Forms.Panel
$header.Dock = 'Top'; $header.Height = 58; $header.BackColor = $c_surface3
$form.Controls.Add($header)

$brand1 = New-Object System.Windows.Forms.Label
$brand1.Text = 'StoryVault'; $brand1.AutoSize = $true
$brand1.Font = New-Object System.Drawing.Font('Consolas', 15, [System.Drawing.FontStyle]::Bold)
$brand1.ForeColor = $c_acc2; $brand1.Location = New-Object System.Drawing.Point(18, 14)
$header.Controls.Add($brand1)
$brand2 = New-Object System.Windows.Forms.Label
$brand2.Text = 'LAUNCHER'; $brand2.AutoSize = $true
$brand2.Font = New-Object System.Drawing.Font('Consolas', 15, [System.Drawing.FontStyle]::Bold)
$brand2.ForeColor = $c_muted; $brand2.Location = New-Object System.Drawing.Point(140, 14)
$header.Controls.Add($brand2)

$hdrStatus = New-Object System.Windows.Forms.Label
$hdrStatus.Text = 'Ready'; $hdrStatus.AutoSize = $true; $hdrStatus.ForeColor = $c_muted
$hdrStatus.Font = New-Object System.Drawing.Font('Consolas', 9.5, [System.Drawing.FontStyle]::Bold)
$hdrStatus.Anchor = 'Top,Right'; $hdrStatus.Location = New-Object System.Drawing.Point(820, 20)
$header.Controls.Add($hdrStatus)

# --- left tab rail ---
$rail = New-Object System.Windows.Forms.Panel
$rail.Dock = 'Left'; $rail.Width = 150; $rail.BackColor = $c_surface
$form.Controls.Add($rail)

# --- content host ---
$content = New-Object System.Windows.Forms.Panel
$content.Dock = 'Fill'; $content.BackColor = $c_bg
$form.Controls.Add($content)
$content.BringToFront()

$pnlLaunch   = New-Object System.Windows.Forms.Panel; $pnlLaunch.Dock = 'Fill'; $pnlLaunch.BackColor = $c_bg
$pnlSettings = New-Object System.Windows.Forms.Panel; $pnlSettings.Dock = 'Fill'; $pnlSettings.BackColor = $c_bg; $pnlSettings.Visible = $false
$pnlAbout    = New-Object System.Windows.Forms.Panel; $pnlAbout.Dock = 'Fill'; $pnlAbout.BackColor = $c_bg; $pnlAbout.Visible = $false
$content.Controls.AddRange(@($pnlLaunch, $pnlSettings, $pnlAbout))

function Show-Tab($name) {
  $pnlLaunch.Visible   = ($name -eq 'launch')
  $pnlSettings.Visible = ($name -eq 'settings')
  $pnlAbout.Visible    = ($name -eq 'about')
  foreach ($b in @($tabLaunch, $tabSettings, $tabAbout)) {
    $b.BackColor = $c_surface
    $b.ForeColor = $c_muted
  }
  $sel = switch ($name) { 'launch' { $tabLaunch } 'settings' { $tabSettings } 'about' { $tabAbout } }
  $sel.BackColor = $c_surface2; $sel.ForeColor = $c_text
}
function New-Tab($text, $y, $name) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text; $b.Location = New-Object System.Drawing.Point(10, $y); $b.Size = New-Object System.Drawing.Size(130, 40)
  $b.FlatStyle = 'Flat'; $b.FlatAppearance.BorderSize = 0; $b.TextAlign = 'MiddleLeft'
  $b.ForeColor = $c_muted; $b.BackColor = $c_surface
  $b.Font = New-Object System.Drawing.Font('Consolas', 10, [System.Drawing.FontStyle]::Bold); $b.Cursor = 'Hand'
  $b.Add_Click({ Show-Tab $name }.GetNewClosure())
  $rail.Controls.Add($b)
  return $b
}
$tabLaunch   = New-Tab '  ▶  Launch'   14  'launch'
$tabSettings = New-Tab '  ⚙  Settings' 60  'settings'
$tabAbout    = New-Tab '  ⓘ  About'    106 'about'

# ============================== shared button helpers ========================
function New-FlatBtn($text, $accent) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text; $b.AutoSize = $false; $b.Height = 28
  $b.Width = [Math]::Max(96, ($text.Length * 8) + 22)
  $b.FlatStyle = 'Flat'; $b.FlatAppearance.BorderColor = $c_border; $b.FlatAppearance.BorderSize = 1
  if ($accent) { $b.ForeColor = [System.Drawing.Color]::White; $b.BackColor = $accent }
  else { $b.ForeColor = $c_text; $b.BackColor = $c_surface2 }
  $b.Font = New-Object System.Drawing.Font('Segoe UI', 8.5, [System.Drawing.FontStyle]::Bold); $b.Cursor = 'Hand'
  $b.Margin = New-Object System.Windows.Forms.Padding(0, 0, 7, 0)
  return $b
}

# ============================== Launch tab: service cards ====================
function New-Card($parent, $y, $titleText, $subText) {
  $card = New-Object System.Windows.Forms.Panel
  $card.Location = New-Object System.Drawing.Point(16, $y)
  $card.Size = New-Object System.Drawing.Size(800, 90)
  $card.Anchor = 'Top,Left,Right'; $card.BackColor = $c_surface
  $card.Add_Paint({ param($s,$e)
    $r = $s.ClientRectangle; $r.Width -= 1; $r.Height -= 1
    $pen = New-Object System.Drawing.Pen($c_border); $e.Graphics.DrawRectangle($pen, $r); $pen.Dispose()
  })
  $dot = New-Object System.Windows.Forms.Label
  $dot.Text = '●'; $dot.AutoSize = $true; $dot.Location = New-Object System.Drawing.Point(14, 12)
  $dot.Font = New-Object System.Drawing.Font('Segoe UI', 12); $dot.ForeColor = $c_muted
  $t = New-Object System.Windows.Forms.Label
  $t.Text = $titleText; $t.AutoSize = $true; $t.Location = New-Object System.Drawing.Point(38, 11)
  $t.Font = New-Object System.Drawing.Font('Consolas', 11, [System.Drawing.FontStyle]::Bold); $t.ForeColor = $c_text
  $sub = New-Object System.Windows.Forms.Label
  $sub.Text = $subText; $sub.AutoSize = $true; $sub.Location = New-Object System.Drawing.Point(38, 33)
  $sub.Font = New-Object System.Drawing.Font('Consolas', 8.5); $sub.ForeColor = $c_muted
  $btns = New-Object System.Windows.Forms.FlowLayoutPanel
  $btns.Location = New-Object System.Drawing.Point(36, 52); $btns.Size = New-Object System.Drawing.Size(750, 32)
  $btns.Anchor = 'Top,Left,Right'; $btns.WrapContents = $false; $btns.FlowDirection = 'LeftToRight'; $btns.BackColor = $c_surface
  $card.Controls.AddRange(@($dot, $t, $sub, $btns))
  $parent.Controls.Add($card)
  return [pscustomobject]@{ Card = $card; Dot = $dot; Title = $t; Sub = $sub; Btns = $btns }
}
function Set-Dot($lbl, $state) {
  switch ($state) { 'on' { $lbl.ForeColor = $c_ok } 'off' { $lbl.ForeColor = $c_err } default { $lbl.ForeColor = $c_muted } }
}

$cardWeb  = New-Card $pnlLaunch 14  'Web UI  ·  StoryVault'              ("http://127.0.0.1:" + $script:cfg.port)
$cardFish = New-Card $pnlLaunch 110 'Fish Speech S2 Pro'                 $script:cfg.fishUrl
$cardLlm  = New-Card $pnlLaunch 244 'Local LLM  (Ollama / llama.cpp)'    $script:cfg.llmUrl

# Web UI buttons
$btnInstall = New-FlatBtn '⬇ Install deps'  $null
$btnStart   = New-FlatBtn '▶ Start'         $c_ok
$btnStop    = New-FlatBtn '■ Stop'          $null
$btnOpen    = New-FlatBtn '🌐 Open'         $c_acc
$btnStop.Enabled = $false; $btnOpen.Enabled = $false
$cardWeb.Btns.Controls.AddRange(@($btnInstall, $btnStart, $btnStop, $btnOpen))

# Header global action: start every service the launcher manages (Web UI + Fish).
# The Local LLM (Ollama) is external and not launchable here, so a tooltip spells
# out the scope. Enabled-state is managed in Test-Deps (gated on Node + npm).
$btnStartAll = New-FlatBtn '⏯ Start All' $c_ok
$btnStartAll.Location = New-Object System.Drawing.Point(648, 15); $btnStartAll.Anchor = 'Top,Right'
$header.Controls.Add($btnStartAll)
$ttStartAll = New-Object System.Windows.Forms.ToolTip
$ttStartAll.SetToolTip($btnStartAll, 'Starts the Web UI + Fish Speech servers. The Local LLM (Ollama) is external — start it separately.')

# Fish buttons
$btnFishServe    = New-FlatBtn '▶ Start Server'        $c_ok
$btnFishStop     = New-FlatBtn '■ Stop'                $null
$btnFishDownload = New-FlatBtn '⬇ Download Model'      $null
$btnFishRepair   = New-FlatBtn '🛠 Repair'             $c_warn
$btnFishModel    = New-FlatBtn '📁 Choose Model Folder' $null
$btnFishLogs     = New-FlatBtn '📋 View Logs'          $null
$btnFishStop.Enabled = $false
# allow the extra buttons to wrap to a second row and give the card room for them
$cardFish.Btns.WrapContents = $true
$cardFish.Btns.Height = 64
$cardFish.Card.Height = 124
$cardFish.Btns.Controls.AddRange(@($btnFishServe, $btnFishStop, $btnFishDownload, $btnFishRepair, $btnFishModel, $btnFishLogs))

# LLM buttons
$btnLlmOpen = New-FlatBtn '🌐 Ollama site' $null
$cardLlm.Btns.Controls.Add($btnLlmOpen)

# dependency status line
$depLbl = New-Object System.Windows.Forms.Label
$depLbl.Location = New-Object System.Drawing.Point(16, 346); $depLbl.Size = New-Object System.Drawing.Size(780, 22)
$depLbl.Anchor = 'Top,Left,Right'; $depLbl.ForeColor = $c_muted
$pnlLaunch.Controls.Add($depLbl)

# console
$consoleLbl = New-Object System.Windows.Forms.Label
$consoleLbl.Text = 'CONSOLE'; $consoleLbl.AutoSize = $true; $consoleLbl.ForeColor = $c_muted
$consoleLbl.Font = New-Object System.Drawing.Font('Consolas', 8, [System.Drawing.FontStyle]::Bold)
$consoleLbl.Location = New-Object System.Drawing.Point(16, 374)
$pnlLaunch.Controls.Add($consoleLbl)

$log = New-Object System.Windows.Forms.TextBox
$log.Multiline = $true; $log.ReadOnly = $true; $log.ScrollBars = 'Vertical'
$log.BackColor = $c_surface3; $log.ForeColor = [System.Drawing.Color]::FromArgb(176, 200, 208)
$log.Font = New-Object System.Drawing.Font('Consolas', 9)
$log.Location = New-Object System.Drawing.Point(16, 394); $log.Size = New-Object System.Drawing.Size(800, 232)
$log.Anchor = 'Top,Bottom,Left,Right'; $log.BorderStyle = 'FixedSingle'
$pnlLaunch.Controls.Add($log)

function Append-Log([string]$text) {
  if ($null -eq $text) { return }
  $stamp = (Get-Date -Format 'HH:mm:ss')
  $log.AppendText("[$stamp] $text`r`n")
}
function Set-HdrStatus([string]$text, $color) { $hdrStatus.Text = $text; $hdrStatus.ForeColor = $color }

# ============================== Settings tab =================================
function New-SettingRow($parent, $y, $labelText) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $labelText; $l.AutoSize = $true; $l.ForeColor = $c_muted
  $l.Font = New-Object System.Drawing.Font('Consolas', 8.5, [System.Drawing.FontStyle]::Bold)
  $l.Location = New-Object System.Drawing.Point(20, $y)
  $parent.Controls.Add($l)
  $tb = New-Object System.Windows.Forms.TextBox
  $tb.Location = New-Object System.Drawing.Point(20, ($y + 20)); $tb.Size = New-Object System.Drawing.Size(540, 24)
  $tb.Anchor = 'Top,Left,Right'; $tb.BackColor = $c_surface2; $tb.ForeColor = $c_text; $tb.BorderStyle = 'FixedSingle'
  $tb.Font = New-Object System.Drawing.Font('Consolas', 9)
  $parent.Controls.Add($tb)
  return $tb
}
$setHdr = New-Object System.Windows.Forms.Label
$setHdr.Text = 'EXTERNAL SERVERS & STARTUP'; $setHdr.AutoSize = $true; $setHdr.ForeColor = $c_text
$setHdr.Font = New-Object System.Drawing.Font('Consolas', 10, [System.Drawing.FontStyle]::Bold)
$setHdr.Location = New-Object System.Drawing.Point(20, 18); $pnlSettings.Controls.Add($setHdr)

$tbLlm   = New-SettingRow $pnlSettings 54  'LOCAL LLM URL (Ollama /v1 or llama.cpp /v1)'
$tbFish  = New-SettingRow $pnlSettings 110 'FISH SPEECH TTS URL'
$tbModel = New-SettingRow $pnlSettings 166 'FISH MODEL FOLDER'
$tbBin   = New-SettingRow $pnlSettings 222 'FISH SERVER BINARY (s2 GGUF server .exe)'
$tbPort  = New-SettingRow $pnlSettings 278 'WEB UI PORT'

$btnBrowseModel = New-FlatBtn '📁 Browse' $null
$btnBrowseModel.Location = New-Object System.Drawing.Point(570, 186); $btnBrowseModel.Anchor = 'Top,Right'
$pnlSettings.Controls.Add($btnBrowseModel)
$btnBrowseBin = New-FlatBtn '📁 Browse' $null
$btnBrowseBin.Location = New-Object System.Drawing.Point(570, 242); $btnBrowseBin.Anchor = 'Top,Right'
$pnlSettings.Controls.Add($btnBrowseBin)

$chkAuth = New-Object System.Windows.Forms.CheckBox
$chkAuth.Text = 'Require login (multi-user accounts)'; $chkAuth.AutoSize = $true; $chkAuth.ForeColor = $c_text
$chkAuth.Font = New-Object System.Drawing.Font('Consolas', 9.5); $chkAuth.Location = New-Object System.Drawing.Point(20, 326)
$pnlSettings.Controls.Add($chkAuth)

$btnSaveSettings = New-FlatBtn '💾 Save & apply' $c_acc
$btnSaveSettings.Width = 160; $btnSaveSettings.Height = 34
$btnSaveSettings.Location = New-Object System.Drawing.Point(20, 364)
$pnlSettings.Controls.Add($btnSaveSettings)

$setNote = New-Object System.Windows.Forms.Label
$setNote.Text = 'Saved to data\launcher-config.json and .env. Restart the Web UI to apply.'
$setNote.AutoSize = $true; $setNote.ForeColor = $c_muted; $setNote.Location = New-Object System.Drawing.Point(20, 408)
$pnlSettings.Controls.Add($setNote)

function Load-SettingsUI {
  $tbLlm.Text = $script:cfg.llmUrl; $tbFish.Text = $script:cfg.fishUrl
  $tbModel.Text = $script:cfg.fishModelDir; $tbBin.Text = $script:cfg.fishBin
  $tbPort.Text = $script:cfg.port; $chkAuth.Checked = [bool]$script:cfg.authEnabled
}
Load-SettingsUI

# ============================== About tab ====================================
$aboutTxt = New-Object System.Windows.Forms.Label
$aboutTxt.AutoSize = $false; $aboutTxt.Location = New-Object System.Drawing.Point(20, 20)
$aboutTxt.Size = New-Object System.Drawing.Size(760, 420); $aboutTxt.Anchor = 'Top,Left,Right,Bottom'
$aboutTxt.ForeColor = $c_text; $aboutTxt.Font = New-Object System.Drawing.Font('Consolas', 9.5)
$ver = '1.0.0'
try { $pkg = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json; if ($pkg.version) { $ver = $pkg.version } } catch { }
$aboutTxt.Text = @"
StoryVault Video Factory  ·  v$ver

Web app   : Node.js + Express  (server.js on port $($script:cfg.port))
Renderer  : FFmpeg
Voice     : Windows SAPI (built-in) + Fish Speech S2 Pro (local GGUF)
Local AI  : Ollama / llama.cpp  (script generation)

Project   : $Root

Tabs:
  • Launch   — start/stop the Web UI, manage Fish Speech, watch the console
  • Settings — external server URLs, Fish model folder, port, login toggle

This launcher needs nothing pre-installed: the Install button fetches
Node.js, FFmpeg and the npm packages automatically.
"@
$pnlAbout.Controls.Add($aboutTxt)

# ============================ dependency logic ===============================
function Refresh-Path {
  $machine = [System.Environment]::GetEnvironmentVariable('Path','Machine')
  $user    = [System.Environment]::GetEnvironmentVariable('Path','User')
  $extra = @()
  if (Test-Path (Join-Path $BinNode 'node.exe')) { $extra += $BinNode }
  if (Test-Path (Join-Path $BinFf 'bin\ffmpeg.exe')) { $extra += (Join-Path $BinFf 'bin') }
  $env:Path = (($extra + $machine + $user) -join ';')
}
function Resolve-Tools {
  Refresh-Path
  $node = if (Test-Path (Join-Path $BinNode 'node.exe')) { Join-Path $BinNode 'node.exe' }
          else { (Get-Command node.exe -ErrorAction SilentlyContinue).Source }
  $ff   = if (Test-Path (Join-Path $BinFf 'bin\ffmpeg.exe')) { Join-Path $BinFf 'bin\ffmpeg.exe' }
          else { (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue).Source }
  $fp   = if (Test-Path (Join-Path $BinFf 'bin\ffprobe.exe')) { Join-Path $BinFf 'bin\ffprobe.exe' }
          else { (Get-Command ffprobe.exe -ErrorAction SilentlyContinue).Source }
  $script:NodeExe = $node; $script:FfmpegExe = $ff; $script:FfprobeExe = $fp
}
function Test-Deps {
  Resolve-Tools
  $hasNode = [bool]$script:NodeExe
  $hasFf   = [bool]$script:FfmpegExe -and [bool]$script:FfprobeExe
  $hasPkgs = Test-Path (Join-Path $Root 'node_modules\express')
  $mk = { param($ok) if ($ok) { '✓' } else { '✗' } }
  $depLbl.Text = "Node.js $(& $mk $hasNode)    FFmpeg $(& $mk $hasFf)    npm packages $(& $mk $hasPkgs)"
  $depLbl.ForeColor = if ($hasNode -and $hasFf -and $hasPkgs) { $c_ok } else { $c_warn }
  $btnStart.Enabled = ($hasNode -and $hasPkgs -and -not $script:ServerProc)
  # "Start All" only needs the core deps; it stays enabled while a service runs so
  # it can still bring up whichever one isn't up yet (each callee no-ops if running).
  $btnStartAll.Enabled = ($hasNode -and $hasPkgs)
  return [pscustomobject]@{ Node = $hasNode; Ffmpeg = $hasFf; Pkgs = $hasPkgs }
}

function Invoke-Logged([string]$file, [string]$arguments, [string]$workdir) {
  Append-Log ">> $file $arguments"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $file; $psi.Arguments = $arguments; $psi.WorkingDirectory = $workdir
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
  $p = New-Object System.Diagnostics.Process; $p.StartInfo = $psi
  $handler = { param($s,$e) if ($null -ne $e.Data) { $script:procQueue.Enqueue($e.Data) } }
  $p.add_OutputDataReceived($handler); $p.add_ErrorDataReceived($handler)
  try { [void]$p.Start(); $p.BeginOutputReadLine(); $p.BeginErrorReadLine() }
  catch { Append-Log "ERROR launching $file : $($_.Exception.Message)"; return 1 }
  while (-not $p.HasExited) {
    $line = $null
    while ($script:procQueue.TryDequeue([ref]$line)) { Append-Log $line }
    [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 100
  }
  $line = $null
  while ($script:procQueue.TryDequeue([ref]$line)) { Append-Log $line }
  return $p.ExitCode
}
function Download-File([string]$url, [string]$dest) {
  Append-Log "Downloading $url"
  $old = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
    [System.Windows.Forms.Application]::DoEvents(); return $true
  } catch { Append-Log "Download failed: $($_.Exception.Message)"; return $false }
  finally { $ProgressPreference = $old }
}
function Have-Winget { [bool](Get-Command winget.exe -ErrorAction SilentlyContinue) }

function Ensure-Node {
  Resolve-Tools
  if ($script:NodeExe) { Append-Log "Node.js found: $script:NodeExe"; return $true }
  Append-Log 'Node.js not found — installing…'
  if (Have-Winget) {
    Invoke-Logged 'winget.exe' 'install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements' $Root | Out-Null
    Resolve-Tools; if ($script:NodeExe) { Append-Log 'Node.js installed via winget.'; return $true }
  }
  Append-Log 'Falling back to portable Node.js download…'
  $verN = 'v20.18.1'; $zip = Join-Path $env:TEMP "node-$verN.zip"
  if (-not (Download-File "https://nodejs.org/dist/$verN/node-$verN-win-x64.zip" $zip)) { return $false }
  New-Item -ItemType Directory -Force -Path $BinNode | Out-Null
  $tmp = Join-Path $env:TEMP "node-extract-$([guid]::NewGuid())"
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
  Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $BinNode -Recurse -Force
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Resolve-Tools; if ($script:NodeExe) { Append-Log 'Portable Node.js ready.'; return $true }
  Append-Log 'Could not install Node.js automatically. Install from https://nodejs.org and retry.'; return $false
}
function Ensure-Ffmpeg {
  Resolve-Tools
  if ($script:FfmpegExe -and $script:FfprobeExe) { Append-Log "FFmpeg found: $script:FfmpegExe"; return $true }
  Append-Log 'FFmpeg not found — installing…'
  if (Have-Winget) {
    Invoke-Logged 'winget.exe' 'install -e --id Gyan.FFmpeg --silent --accept-package-agreements --accept-source-agreements' $Root | Out-Null
    Resolve-Tools; if ($script:FfmpegExe -and $script:FfprobeExe) { Append-Log 'FFmpeg installed via winget.'; return $true }
  }
  Append-Log 'Falling back to portable FFmpeg download (this can take a minute)…'
  $zip = Join-Path $env:TEMP 'ffmpeg-essentials.zip'
  if (-not (Download-File 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' $zip)) { return $false }
  $tmp = Join-Path $env:TEMP "ff-extract-$([guid]::NewGuid())"
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
  New-Item -ItemType Directory -Force -Path $BinFf | Out-Null
  Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $BinFf -Recurse -Force
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Resolve-Tools; if ($script:FfmpegExe) { Append-Log 'Portable FFmpeg ready.'; return $true }
  Append-Log 'Could not install FFmpeg automatically.'; return $false
}
function Do-Install {
  $btnInstall.Enabled = $false; $btnStart.Enabled = $false
  try {
    Append-Log '=== Installing dependencies ==='
    $okNode = Ensure-Node
    Ensure-Ffmpeg | Out-Null
    if ($okNode) {
      Append-Log 'Installing npm packages (express, multer)…'
      $npmDir = Split-Path $script:NodeExe -Parent; $env:Path = "$npmDir;$env:Path"
      $code = Invoke-Logged 'cmd.exe' '/c npm install --no-fund --no-audit' $Root
      if ($code -eq 0) {
        Append-Log 'npm packages installed.'
        Invoke-Logged $script:NodeExe '--no-warnings scripts/init-db.js' $Root | Out-Null
        Invoke-Logged $script:NodeExe '--no-warnings scripts/seed.js' $Root | Out-Null
        Append-Log '=== Install complete. Click Start. ==='
      } else { Append-Log "npm install failed (exit $code)." }
    }
  } catch { Append-Log "Install error: $($_.Exception.Message)" }
  finally { $btnInstall.Enabled = $true; Test-Deps | Out-Null }
}

# =============================== start/stop ==================================
function Start-Server {
  $d = Test-Deps
  if (-not $d.Node) { Append-Log 'Node.js is missing — click "Install deps" first.'; return }
  if (-not $d.Pkgs) { Append-Log 'npm packages missing — click "Install deps" first.'; return }
  if ($script:ServerProc) { Append-Log 'Server already running.'; return }
  Refresh-Path
  if ($script:FfmpegExe)  { $env:FFMPEG_PATH  = $script:FfmpegExe }
  if ($script:FfprobeExe) { $env:FFPROBE_PATH = $script:FfprobeExe }
  $env:PORT = $script:cfg.port
  $env:LOCAL_LLM_URL = $script:cfg.llmUrl
  $env:FISH_TTS_URL = $script:cfg.fishUrl
  if ($script:cfg.fishModelDir) { $env:FISH_MODEL_DIR = $script:cfg.fishModelDir }
  if ($script:cfg.fishBin) { $env:FISH_S2_BIN = $script:cfg.fishBin }
  $env:AUTH_ENABLED = if ($script:cfg.authEnabled) { 'true' } else { 'false' }
  Write-EnvFile
  '' | Set-Content $OutLog; '' | Set-Content $ErrLog
  $script:OutPos = 0; $script:ErrPos = 0
  Append-Log 'Starting Web UI server…'
  try {
    $script:ServerProc = Start-Process -FilePath $script:NodeExe `
      -ArgumentList @('--no-warnings','server.js') -WorkingDirectory $Root `
      -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -WindowStyle Hidden -PassThru
  } catch { Append-Log "Failed to start: $($_.Exception.Message)"; $script:ServerProc = $null; return }
  Set-HdrStatus 'Web UI online' $c_ok
  $btnStart.Enabled = $false; $btnStop.Enabled = $true; $btnOpen.Enabled = $true
  $script:openTimer.Start(); $logTimer.Start()
}
function Stop-Server {
  if (-not $script:ServerProc) { Append-Log 'Server is not running.'; return }
  Append-Log 'Stopping server…'
  $procId = $script:ServerProc.Id
  try { & taskkill.exe '/PID' $procId '/T' '/F' 2>&1 | Out-Null } catch { }
  try { if (-not $script:ServerProc.HasExited) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } } catch { }
  $script:ServerProc = $null
  Set-HdrStatus 'Stopped' $c_muted
  $btnStop.Enabled = $false; $btnOpen.Enabled = $false; $logTimer.Stop()
  Test-Deps | Out-Null
}
# Start every service this launcher can run: the Web UI server + the Fish Speech
# server. Each callee logs its own status and no-ops if already running or if
# prerequisites are missing, so this is safe to click at any time.
function Start-All {
  Append-Log '=== Start All: launching Web UI + Fish Speech ==='
  Start-Server
  Fish-Start
}

# tail the server log files into the GUI
function Read-Tail([string]$path, [ref]$pos) {
  if (-not (Test-Path $path)) { return }
  try {
    $fs = [System.IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
    $fs.Seek($pos.Value, 'Begin') | Out-Null
    $sr = New-Object System.IO.StreamReader($fs)
    $txt = $sr.ReadToEnd(); $pos.Value = $fs.Position; $sr.Close(); $fs.Close()
    if ($txt) { foreach ($l in ($txt -split "`r?`n")) { if ($l.Trim()) { Append-Log $l } } }
  } catch { }
}
$logTimer = New-Object System.Windows.Forms.Timer
$logTimer.Interval = 700
$logTimer.Add_Tick({
  Read-Tail $OutLog ([ref]$script:OutPos)
  Read-Tail $ErrLog ([ref]$script:ErrPos)
  if ($script:ServerProc -and $script:ServerProc.HasExited) {
    Append-Log "Server process exited (code $($script:ServerProc.ExitCode))."
    $script:ServerProc = $null; Set-HdrStatus 'Stopped' $c_warn
    $btnStop.Enabled = $false; $btnOpen.Enabled = $false; $logTimer.Stop(); Test-Deps | Out-Null
  }
})
$script:openTimer = New-Object System.Windows.Forms.Timer
$script:openTimer.Interval = 1800
$script:openTimer.Add_Tick({ $script:openTimer.Stop(); Start-Process ("http://127.0.0.1:" + $script:cfg.port) })

# tail the Fish Speech server logs + detect its exit (runs only while Fish is up)
$script:fishLogTimer = New-Object System.Windows.Forms.Timer
$script:fishLogTimer.Interval = 700
$script:fishLogTimer.Add_Tick({
  Read-Tail $FishOut ([ref]$script:FishOutPos)
  Read-Tail $FishErr ([ref]$script:FishErrPos)
  if ($script:FishProc -and $script:FishProc.HasExited) {
    Append-Log "Fish Speech server exited (code $($script:FishProc.ExitCode))."
    $script:FishProc = $null; $script:fishLogTimer.Stop(); Set-Dot $cardFish.Dot 'off'
    $btnFishServe.Enabled = $true; $btnFishStop.Enabled = $false
  }
})

# =============================== status poll =================================
function Test-Port([int]$port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect('127.0.0.1', $port, $null, $null)
    $okc = $iar.AsyncWaitHandle.WaitOne(250)
    if ($okc -and $c.Connected) { $c.EndConnect($iar); $c.Close(); return $true }
    $c.Close(); return $false
  } catch { return $false }
}
$pollTimer = New-Object System.Windows.Forms.Timer
$pollTimer.Interval = 2500
$pollTimer.Add_Tick({
  $pWeb = 0; if ($script:cfg.port -match '^\d+$') { $pWeb = [int]$script:cfg.port }
  $pFish = 8080; if ($script:cfg.fishUrl -match ':(\d+)') { $pFish = [int]$Matches[1] }
  $pLlm = 11434; if ($script:cfg.llmUrl -match ':(\d+)') { $pLlm = [int]$Matches[1] }
  if ($pWeb -gt 0) { if (Test-Port $pWeb) { Set-Dot $cardWeb.Dot 'on' } else { Set-Dot $cardWeb.Dot 'off' } }
  if (Test-Port $pFish) { Set-Dot $cardFish.Dot 'on' } else { Set-Dot $cardFish.Dot 'off' }
  if (Test-Port $pLlm)  { Set-Dot $cardLlm.Dot 'on' }  else { Set-Dot $cardLlm.Dot 'off' }
})
$pollTimer.Start()

# =============================== Fish actions ================================
function Fish-Download {
  Append-Log '=== Fish Speech: downloading model (one GGUF quant via npm run setup:fish) ==='
  $d = Test-Deps
  if (-not $d.Node) { Append-Log 'Node.js missing - install dependencies first.'; return }
  $npmDir = Split-Path $script:NodeExe -Parent; $env:Path = "$npmDir;$env:Path"
  $env:FISH_MODEL_DIR = $script:cfg.fishModelDir
  Invoke-Logged 'cmd.exe' '/c npm run setup:fish' $Root | Out-Null
  Append-Log 'Fish Speech model download finished. Build the s2.cpp engine in the Voice Lab to synthesize.'
}
function Fish-Repair {
  Append-Log '=== Fish Speech: repairing (re-downloading model via npm run setup:fish) ==='
  $d = Test-Deps
  if (-not $d.Node) { Append-Log 'Node.js missing — install dependencies first.'; return }
  $npmDir = Split-Path $script:NodeExe -Parent; $env:Path = "$npmDir;$env:Path"
  $env:FISH_MODEL_DIR = $script:cfg.fishModelDir
  Invoke-Logged 'cmd.exe' '/c npm run setup:fish' $Root | Out-Null
  Append-Log 'Fish Speech repair finished.'
}
# Locate the built s2 engine: an explicit server binary from Settings, else the
# path the build script records in data\fish-settings.json, else the standard
# s2.cpp build output.
function Fish-ResolveBin {
  if ($script:cfg.fishBin -and (Test-Path $script:cfg.fishBin)) { return $script:cfg.fishBin }
  $fset = Join-Path $Root 'data\fish-settings.json'
  if (Test-Path $fset) {
    try { $j = Get-Content $fset -Raw | ConvertFrom-Json; if ($j.s2Bin -and (Test-Path $j.s2Bin)) { return [string]$j.s2Bin } } catch { }
  }
  foreach ($c in @(
      (Join-Path $Root 'data\models\s2.cpp\build\s2.exe'),
      (Join-Path $Root 'data\models\s2.cpp\build\Release\s2.exe'),
      (Join-Path $Root 'data\models\s2.cpp\build\bin\s2.exe'),
      (Join-Path $Root 'data\models\s2.cpp\build\bin\Release\s2.exe'))) {
    if (Test-Path $c) { return $c }
  }
  return $null
}
# First GGUF in the model folder (prefer the s2-pro-*.gguf naming).
function Fish-FindGguf {
  $dir = $script:cfg.fishModelDir
  if (-not $dir -or -not (Test-Path $dir)) { return $null }
  $f = Get-ChildItem -Path $dir -Filter 's2-pro-*.gguf' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $f) { $f = Get-ChildItem -Path $dir -Filter '*.gguf' -ErrorAction SilentlyContinue | Select-Object -First 1 }
  if ($f) { return $f.FullName }
  return $null
}
# Start s2.exe in HTTP server mode on the host/port from the Fish Speech TTS URL.
function Fish-Start {
  if ($script:FishProc -and -not $script:FishProc.HasExited) { Append-Log 'Fish Speech server is already running.'; return }
  $bin = Fish-ResolveBin
  if (-not $bin) {
    Append-Log 'Fish engine not built. Run scripts\build-fish-engine.ps1 first, or set "Fish server binary" in Settings.'
    return
  }
  $gguf = Fish-FindGguf
  if (-not $gguf) { Append-Log "No GGUF model in $($script:cfg.fishModelDir). Click 'Download Model' first."; return }
  $tok = Join-Path $script:cfg.fishModelDir 'tokenizer.json'
  if (-not (Test-Path $tok)) { Append-Log "tokenizer.json missing in the model folder. Click 'Download Model' first."; return }

  $fishHost = '127.0.0.1'; $fishPort = 8080
  if ($script:cfg.fishUrl -match '://\[?([^\]:/]+)') { $fishHost = $Matches[1] }
  if ($script:cfg.fishUrl -match ':(\d+)(?:/|$)')    { $fishPort = [int]$Matches[1] }

  '' | Set-Content $FishOut; '' | Set-Content $FishErr
  $script:FishOutPos = 0; $script:FishErrPos = 0
  $argList = @('--server', '-m', ('"' + $gguf + '"'), '-t', ('"' + $tok + '"'), '-H', $fishHost, '-P', [string]$fishPort)
  Append-Log "Starting Fish Speech server: $(Split-Path $bin -Leaf) --server -H $fishHost -P $fishPort"
  Append-Log "  model: $(Split-Path $gguf -Leaf)"
  try {
    $script:FishProc = Start-Process -FilePath $bin -ArgumentList $argList `
      -WorkingDirectory (Split-Path $bin -Parent) `
      -RedirectStandardOutput $FishOut -RedirectStandardError $FishErr -WindowStyle Hidden -PassThru
  } catch { Append-Log "Failed to start Fish server: $($_.Exception.Message)"; $script:FishProc = $null; return }
  Set-HdrStatus 'Fish Speech starting…' $c_gold
  Set-Dot $cardFish.Dot 'wait'
  $btnFishServe.Enabled = $false; $btnFishStop.Enabled = $true
  $script:fishLogTimer.Start()
}
function Fish-Stop {
  if (-not $script:FishProc) { Append-Log 'Fish Speech server is not running.'; return }
  Append-Log 'Stopping Fish Speech server…'
  $procId = $script:FishProc.Id
  try { & taskkill.exe '/PID' $procId '/T' '/F' 2>&1 | Out-Null } catch { }
  try { if (-not $script:FishProc.HasExited) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } } catch { }
  $script:FishProc = $null; $script:fishLogTimer.Stop()
  Read-Tail $FishOut ([ref]$script:FishOutPos); Read-Tail $FishErr ([ref]$script:FishErrPos)
  Set-Dot $cardFish.Dot 'off'
  $btnFishServe.Enabled = $true; $btnFishStop.Enabled = $false
}
function Fish-ChooseModel {
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = 'Select the folder that contains the s2-pro GGUF files'
  if (Test-Path $script:cfg.fishModelDir) { $dlg.SelectedPath = $script:cfg.fishModelDir }
  if ($dlg.ShowDialog() -eq 'OK') {
    $script:cfg.fishModelDir = $dlg.SelectedPath
    $cardFish.Sub.Text = $script:cfg.fishUrl
    Append-Log "Fish model folder set to $($dlg.SelectedPath)"
    Save-Cfg; Load-SettingsUI
  }
}
function Fish-Logs {
  Append-Log "Opening logs folder: $LogDir"
  try { Start-Process $LogDir } catch { }
}

# =============================== wire up =====================================
$btnStartAll.Add_Click({ Start-All })
$btnInstall.Add_Click({ Do-Install })
$btnStart.Add_Click({ Start-Server })
$btnStop.Add_Click({ Stop-Server })
$btnOpen.Add_Click({ Start-Process ("http://127.0.0.1:" + $script:cfg.port) })
$btnFishServe.Add_Click({ Fish-Start })
$btnFishStop.Add_Click({ Fish-Stop })
$btnFishDownload.Add_Click({ Fish-Download })
$btnFishRepair.Add_Click({ Fish-Repair })
$btnFishModel.Add_Click({ Fish-ChooseModel })
$btnFishLogs.Add_Click({ Fish-Logs })
$btnLlmOpen.Add_Click({ Start-Process 'https://ollama.com/library' })

$btnBrowseModel.Add_Click({
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  if (Test-Path $tbModel.Text) { $dlg.SelectedPath = $tbModel.Text }
  if ($dlg.ShowDialog() -eq 'OK') { $tbModel.Text = $dlg.SelectedPath }
})
$btnBrowseBin.Add_Click({
  $dlg = New-Object System.Windows.Forms.OpenFileDialog
  $dlg.Filter = 'Executables (*.exe)|*.exe|All files (*.*)|*.*'
  if ($dlg.ShowDialog() -eq 'OK') { $tbBin.Text = $dlg.FileName }
})
$btnSaveSettings.Add_Click({
  $script:cfg.llmUrl = $tbLlm.Text.Trim()
  $script:cfg.fishUrl = $tbFish.Text.Trim()
  $script:cfg.fishModelDir = $tbModel.Text.Trim()
  $script:cfg.fishBin = $tbBin.Text.Trim()
  if ($tbPort.Text.Trim() -match '^\d+$') { $script:cfg.port = $tbPort.Text.Trim() }
  $script:cfg.authEnabled = $chkAuth.Checked
  Save-Cfg
  $cardWeb.Sub.Text = "http://127.0.0.1:" + $script:cfg.port
  $cardFish.Sub.Text = $script:cfg.fishUrl
  $cardLlm.Sub.Text = $script:cfg.llmUrl
  Append-Log 'Settings saved to data\launcher-config.json and .env.'
  Set-HdrStatus 'Settings saved' $c_ok
})

$form.Add_FormClosing({ if ($script:ServerProc) { Stop-Server }; if ($script:FishProc) { Fish-Stop } })

Show-Tab 'launch'
Append-Log 'StoryVault launcher ready.'
$d0 = Test-Deps
if (-not ($d0.Node -and $d0.Pkgs)) { Append-Log 'First run: click "Install deps".' }
else { Append-Log 'Dependencies present — click Start.' }

# Self-test hook: SV_SELFTEST=1 builds and auto-closes the window to verify the GUI
# assembles without runtime errors (used during development; harmless otherwise).
if ($env:SV_SELFTEST -eq '1') {
  $selfTimer = New-Object System.Windows.Forms.Timer
  $selfTimer.Interval = 1500
  $selfTimer.Add_Tick({ $selfTimer.Stop(); $form.Close() })
  $selfTimer.Start()
}

[void]$form.ShowDialog()
