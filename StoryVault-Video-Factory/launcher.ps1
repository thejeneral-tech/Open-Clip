# StoryVault Video Factory — desktop launcher (Install / Start / Stop).
# Pure Windows PowerShell + WinForms — needs nothing pre-installed to run itself.
# The Install button fetches everything the app needs: Node.js, FFmpeg, npm packages.

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

$script:ServerProc = $null
$script:NodeExe    = $null
$script:FfmpegExe  = $null
$script:FfprobeExe = $null
$script:OutPos     = 0
$script:ErrPos     = 0
$script:procQueue  = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()

# ============================== UI ==========================================
$c_bg    = [System.Drawing.Color]::FromArgb(14,17,23)
$c_panel = [System.Drawing.Color]::FromArgb(22,27,37)
$c_text  = [System.Drawing.Color]::FromArgb(230,235,242)
$c_muted = [System.Drawing.Color]::FromArgb(141,153,172)
$c_acc   = [System.Drawing.Color]::FromArgb(91,140,255)
$c_ok    = [System.Drawing.Color]::FromArgb(52,211,153)
$c_err   = [System.Drawing.Color]::FromArgb(248,113,113)
$c_warn  = [System.Drawing.Color]::FromArgb(251,191,36)

$form = New-Object System.Windows.Forms.Form
$form.Text = 'StoryVault Video Factory'
$form.Size = New-Object System.Drawing.Size(680, 600)
$form.StartPosition = 'CenterScreen'
$form.BackColor = $c_bg
$form.ForeColor = $c_text
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)
$form.MinimumSize = New-Object System.Drawing.Size(560, 460)

$title = New-Object System.Windows.Forms.Label
$title.Text = '🎬  StoryVault Video Factory'
$title.Font = New-Object System.Drawing.Font('Segoe UI', 15, [System.Drawing.FontStyle]::Bold)
$title.Location = New-Object System.Drawing.Point(20, 16)
$title.AutoSize = $true
$form.Controls.Add($title)

$statusLbl = New-Object System.Windows.Forms.Label
$statusLbl.Text = '● Server: stopped'
$statusLbl.ForeColor = $c_muted
$statusLbl.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$statusLbl.Location = New-Object System.Drawing.Point(22, 52)
$statusLbl.AutoSize = $true
$form.Controls.Add($statusLbl)

# dependency status line
$depLbl = New-Object System.Windows.Forms.Label
$depLbl.Location = New-Object System.Drawing.Point(22, 78)
$depLbl.Size = New-Object System.Drawing.Size(620, 22)
$depLbl.ForeColor = $c_muted
$form.Controls.Add($depLbl)

function New-Btn($text, $x, $w, $accent) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.Location = New-Object System.Drawing.Point($x, 108)
  $b.Size = New-Object System.Drawing.Size($w, 40)
  $b.FlatStyle = 'Flat'
  $b.ForeColor = $c_text
  $b.BackColor = if ($accent) { $c_acc } else { $c_panel }
  $b.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(49,60,80)
  $b.FlatAppearance.BorderSize = 1
  $b.Font = New-Object System.Drawing.Font('Segoe UI', 9.5, [System.Drawing.FontStyle]::Bold)
  $b.Cursor = 'Hand'
  $form.Controls.Add($b)
  return $b
}
$btnInstall = New-Btn '⬇  Install dependencies' 22  200 $false
$btnStart   = New-Btn '▶  Start'                232 120 $true
$btnStop    = New-Btn '■  Stop'                 360 120 $false
$btnOpen    = New-Btn '🌐 Open'                 488 120 $false
$btnStop.Enabled = $false
$btnOpen.Enabled = $false

# log box
$log = New-Object System.Windows.Forms.TextBox
$log.Multiline = $true
$log.ReadOnly = $true
$log.ScrollBars = 'Vertical'
$log.BackColor = [System.Drawing.Color]::FromArgb(10,13,18)
$log.ForeColor = [System.Drawing.Color]::FromArgb(176,189,208)
$log.Font = New-Object System.Drawing.Font('Consolas', 9)
$log.Location = New-Object System.Drawing.Point(22, 162)
$log.Size = New-Object System.Drawing.Size(620, 350)
$log.Anchor = 'Top,Bottom,Left,Right'
$log.BorderStyle = 'FixedSingle'
$form.Controls.Add($log)

$urlLbl = New-Object System.Windows.Forms.Label
$urlLbl.Text = 'http://127.0.0.1:4400'
$urlLbl.ForeColor = $c_acc
$urlLbl.Location = New-Object System.Drawing.Point(22, 520)
$urlLbl.AutoSize = $true
$urlLbl.Anchor = 'Bottom,Left'
$form.Controls.Add($urlLbl)

function Append-Log([string]$text, $color) {
  if ($null -eq $text) { return }
  $stamp = (Get-Date -Format 'HH:mm:ss')
  $log.AppendText("[$stamp] $text`r`n")
}
function Set-Status([string]$text, $color) {
  $statusLbl.Text = "● Server: $text"
  $statusLbl.ForeColor = $color
}

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
  $script:NodeExe    = $node
  $script:FfmpegExe  = $ff
  $script:FfprobeExe = $fp
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
  return [pscustomobject]@{ Node=$hasNode; Ffmpeg=$hasFf; Pkgs=$hasPkgs }
}

# Run a child process, streaming stdout+stderr into the log, keeping UI responsive.
function Invoke-Logged([string]$file, [string]$arguments, [string]$workdir) {
  Append-Log ">> $file $arguments"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $file
  $psi.Arguments = $arguments
  $psi.WorkingDirectory = $workdir
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  $handler = { param($s,$e) if ($null -ne $e.Data) { $script:procQueue.Enqueue($e.Data) } }
  $p.add_OutputDataReceived($handler)
  $p.add_ErrorDataReceived($handler)
  try {
    [void]$p.Start()
    $p.BeginOutputReadLine(); $p.BeginErrorReadLine()
  } catch {
    Append-Log "ERROR launching $file : $($_.Exception.Message)"
    return 1
  }
  while (-not $p.HasExited) {
    $line = $null
    while ($script:procQueue.TryDequeue([ref]$line)) { Append-Log $line }
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 100
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
    [System.Windows.Forms.Application]::DoEvents()
    return $true
  } catch {
    Append-Log "Download failed: $($_.Exception.Message)"
    return $false
  } finally { $ProgressPreference = $old }
}

function Have-Winget { [bool](Get-Command winget.exe -ErrorAction SilentlyContinue) }

function Ensure-Node {
  Resolve-Tools
  if ($script:NodeExe) { Append-Log "Node.js found: $script:NodeExe"; return $true }
  Append-Log 'Node.js not found — installing…'
  if (Have-Winget) {
    Invoke-Logged 'winget.exe' 'install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements' $Root | Out-Null
    Resolve-Tools
    if ($script:NodeExe) { Append-Log 'Node.js installed via winget.'; return $true }
  }
  # portable fallback (no admin required)
  Append-Log 'Falling back to portable Node.js download…'
  $ver = 'v20.18.1'
  $zip = Join-Path $env:TEMP "node-$ver.zip"
  if (-not (Download-File "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" $zip)) { return $false }
  New-Item -ItemType Directory -Force -Path $BinNode | Out-Null
  $tmp = Join-Path $env:TEMP "node-extract-$([guid]::NewGuid())"
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
  Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $BinNode -Recurse -Force
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Resolve-Tools
  if ($script:NodeExe) { Append-Log 'Portable Node.js ready.'; return $true }
  Append-Log 'Could not install Node.js automatically. Install it from https://nodejs.org and click Install again.'
  return $false
}

function Ensure-Ffmpeg {
  Resolve-Tools
  if ($script:FfmpegExe -and $script:FfprobeExe) { Append-Log "FFmpeg found: $script:FfmpegExe"; return $true }
  Append-Log 'FFmpeg not found — installing…'
  if (Have-Winget) {
    Invoke-Logged 'winget.exe' 'install -e --id Gyan.FFmpeg --silent --accept-package-agreements --accept-source-agreements' $Root | Out-Null
    Resolve-Tools
    if ($script:FfmpegExe -and $script:FfprobeExe) { Append-Log 'FFmpeg installed via winget.'; return $true }
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
  Resolve-Tools
  if ($script:FfmpegExe) { Append-Log 'Portable FFmpeg ready.'; return $true }
  Append-Log 'Could not install FFmpeg automatically. Install it and click Install again.'
  return $false
}

function Do-Install {
  $btnInstall.Enabled = $false; $btnStart.Enabled = $false
  try {
    Append-Log '=== Installing dependencies ==='
    $okNode = Ensure-Node
    Ensure-Ffmpeg | Out-Null   # FFmpeg only needed for rendering; don't block on it
    if ($okNode) {
      Append-Log 'Installing npm packages (express, multer)…'
      $npmDir = Split-Path $script:NodeExe -Parent
      $env:Path = "$npmDir;$env:Path"
      $code = Invoke-Logged 'cmd.exe' '/c npm install --no-fund --no-audit' $Root
      if ($code -eq 0) {
        Append-Log 'npm packages installed.'
        Invoke-Logged $script:NodeExe '--no-warnings scripts/init-db.js' $Root | Out-Null
        Invoke-Logged $script:NodeExe '--no-warnings scripts/seed.js' $Root | Out-Null
        Append-Log '=== Install complete. Click Start. ==='
      } else {
        Append-Log "npm install failed (exit $code)."
      }
    }
  } catch {
    Append-Log "Install error: $($_.Exception.Message)"
  } finally {
    $btnInstall.Enabled = $true
    Test-Deps | Out-Null
  }
}

# =============================== start/stop ==================================
function Start-Server {
  $d = Test-Deps
  if (-not $d.Node)  { Append-Log 'Node.js is missing — click "Install dependencies" first.'; return }
  if (-not $d.Pkgs)  { Append-Log 'npm packages missing — click "Install dependencies" first.'; return }
  if ($script:ServerProc) { Append-Log 'Server already running.'; return }

  Refresh-Path
  if ($script:FfmpegExe)  { $env:FFMPEG_PATH  = $script:FfmpegExe }
  if ($script:FfprobeExe) { $env:FFPROBE_PATH = $script:FfprobeExe }
  $env:PORT = '4400'

  '' | Set-Content $OutLog; '' | Set-Content $ErrLog
  $script:OutPos = 0; $script:ErrPos = 0
  Append-Log 'Starting server…'
  try {
    $script:ServerProc = Start-Process -FilePath $script:NodeExe `
      -ArgumentList @('--no-warnings','server.js') -WorkingDirectory $Root `
      -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog `
      -WindowStyle Hidden -PassThru
  } catch {
    Append-Log "Failed to start: $($_.Exception.Message)"; $script:ServerProc = $null; return
  }
  Set-Status 'running' $c_ok
  $btnStart.Enabled = $false; $btnStop.Enabled = $true; $btnOpen.Enabled = $true
  $script:openTimer.Start()
  $logTimer.Start()
}

function Stop-Server {
  if (-not $script:ServerProc) { Append-Log 'Server is not running.'; return }
  Append-Log 'Stopping server…'
  $procId = $script:ServerProc.Id
  # taskkill /T kills the whole tree (incl. any ffmpeg child mid-render); fall back
  # to Stop-Process if taskkill is unavailable for any reason.
  try { & taskkill.exe '/PID' $procId '/T' '/F' 2>&1 | Out-Null } catch { }
  try { if (-not $script:ServerProc.HasExited) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } } catch { }
  $script:ServerProc = $null
  Set-Status 'stopped' $c_muted
  $btnStop.Enabled = $false; $btnOpen.Enabled = $false
  $logTimer.Stop()
  Test-Deps | Out-Null
}

# tail the server log files into the GUI
function Read-Tail([string]$path, [ref]$pos) {
  if (-not (Test-Path $path)) { return }
  try {
    $fs = [System.IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
    $fs.Seek($pos.Value, 'Begin') | Out-Null
    $sr = New-Object System.IO.StreamReader($fs)
    $txt = $sr.ReadToEnd()
    $pos.Value = $fs.Position
    $sr.Close(); $fs.Close()
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
    $script:ServerProc = $null
    Set-Status 'stopped' $c_warn
    $btnStop.Enabled = $false; $btnOpen.Enabled = $false; $logTimer.Stop()
    Test-Deps | Out-Null
  }
})

$script:openTimer = New-Object System.Windows.Forms.Timer
$script:openTimer.Interval = 1800
$script:openTimer.Add_Tick({ $script:openTimer.Stop(); Start-Process 'http://127.0.0.1:4400' })

# =============================== wire up =====================================
$btnInstall.Add_Click({ Do-Install })
$btnStart.Add_Click({ Start-Server })
$btnStop.Add_Click({ Stop-Server })
$btnOpen.Add_Click({ Start-Process 'http://127.0.0.1:4400' })
$urlLbl.Add_Click({ Start-Process 'http://127.0.0.1:4400' })
$form.Add_FormClosing({ if ($script:ServerProc) { Stop-Server } })

Append-Log 'StoryVault launcher ready.'
$d0 = Test-Deps
if (-not ($d0.Node -and $d0.Pkgs)) { Append-Log 'First run: click "Install dependencies".' }
else { Append-Log 'Dependencies present — click Start.' }

# Self-test hook: SV_SELFTEST=1 builds and auto-closes the window to verify the GUI
# assembles without runtime errors (used during development; harmless otherwise).
if ($env:SV_SELFTEST -eq '1') {
  $selfTimer = New-Object System.Windows.Forms.Timer
  $selfTimer.Interval = 1200
  $selfTimer.Add_Tick({ $selfTimer.Stop(); $form.Close() })
  $selfTimer.Start()
}

[void]$form.ShowDialog()
