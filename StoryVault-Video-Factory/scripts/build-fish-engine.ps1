# Build the Fish Speech s2.cpp engine from source using a portable, admin-free
# toolchain: portable CMake + llvm-mingw (Clang/LLVM, Defender-safe) + Ninja.
# No Visual Studio / UAC needed. On success, writes the s2 binary path into
# data/fish-settings.json so the app uses it. ASCII-only (robust PS parsing).
$ErrorActionPreference = 'Stop'
$Root      = Split-Path $PSScriptRoot -Parent
$BinDir    = Join-Path $Root 'bin'
$CmakeDir  = Join-Path $BinDir 'cmake'
$LlvmDir   = Join-Path $BinDir 'llvm-mingw'
$NinjaDir  = Join-Path $BinDir 'ninja'
$EngineDir = Join-Path $Root 'data\models\s2.cpp'
$SettingsF = Join-Path $Root 'data\fish-settings.json'
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

function Log($m) { Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }
# Run a native exe, logging merged stdout+stderr WITHOUT letting stderr lines
# become terminating NativeCommandErrors (PS 5.1 quirk). Returns the exit code.
function Native($exe, [string[]]$argList) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $exe @argList 2>&1 | ForEach-Object { Log $_ } } finally { $ErrorActionPreference = $prev }
  return $LASTEXITCODE
}
function Download($url, $dest) {
  Log "Downloading $url"
  $old = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing; return $true }
  catch { Log "Download failed: $($_.Exception.Message)"; return $false }
  finally { $ProgressPreference = $old }
}

# --- 1) portable CMake -------------------------------------------------------
$CmakeExe = Get-ChildItem -Path $CmakeDir -Recurse -Filter cmake.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $CmakeExe) {
  $zip = Join-Path $env:TEMP 'cmake-portable.zip'
  if (-not (Download 'https://github.com/Kitware/CMake/releases/download/v4.3.3/cmake-4.3.3-windows-x86_64.zip' $zip)) { throw 'Could not download CMake.' }
  Log 'Extracting CMake...'
  New-Item -ItemType Directory -Force -Path $CmakeDir | Out-Null
  Expand-Archive -Path $zip -DestinationPath $CmakeDir -Force
  $CmakeExe = Get-ChildItem -Path $CmakeDir -Recurse -Filter cmake.exe | Select-Object -First 1
}
if (-not $CmakeExe) { throw 'cmake.exe not found after extraction.' }
$CmakeBin = $CmakeExe.DirectoryName
Log "CMake: $($CmakeExe.FullName)"

# --- 2) llvm-mingw (Clang/LLVM) ----------------------------------------------
$Clang = Get-ChildItem -Path $LlvmDir -Recurse -Filter clang.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $Clang) {
  $zip = Join-Path $env:TEMP 'llvm-mingw.zip'
  if (-not (Download 'https://github.com/mstorsjo/llvm-mingw/releases/download/20260602/llvm-mingw-20260602-ucrt-x86_64.zip' $zip)) { throw 'Could not download llvm-mingw.' }
  Log 'Extracting llvm-mingw (large - Defender may scan slowly)...'
  New-Item -ItemType Directory -Force -Path $LlvmDir | Out-Null
  Expand-Archive -Path $zip -DestinationPath $LlvmDir -Force
  $Clang = Get-ChildItem -Path $LlvmDir -Recurse -Filter clang.exe | Select-Object -First 1
}
if (-not $Clang) { throw 'clang.exe not found after extraction.' }
$LlvmBin = $Clang.DirectoryName
$ClangXX = Join-Path $LlvmBin 'clang++.exe'
Log "Clang: $($Clang.FullName)"

# --- 3) Ninja ----------------------------------------------------------------
$Ninja = Get-ChildItem -Path $NinjaDir -Recurse -Filter ninja.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $Ninja) {
  $zip = Join-Path $env:TEMP 'ninja-win.zip'
  if (-not (Download 'https://github.com/ninja-build/ninja/releases/latest/download/ninja-win.zip' $zip)) { throw 'Could not download Ninja.' }
  Log 'Extracting Ninja...'
  New-Item -ItemType Directory -Force -Path $NinjaDir | Out-Null
  Expand-Archive -Path $zip -DestinationPath $NinjaDir -Force
  $Ninja = Get-ChildItem -Path $NinjaDir -Recurse -Filter ninja.exe | Select-Object -First 1
}
if (-not $Ninja) { throw 'ninja.exe not found after extraction.' }
Log "Ninja: $($Ninja.FullName)"

# toolchains on PATH for this process
$env:Path = "$LlvmBin;$CmakeBin;$($Ninja.DirectoryName);$env:Path"

# --- 4) clone s2.cpp ---------------------------------------------------------
if (Test-Path (Join-Path $EngineDir 'CMakeLists.txt')) {
  Log 'Using existing s2.cpp clone.'
} else {
  Log 'Cloning s2.cpp (with submodules)...'
  if (Test-Path $EngineDir) { Remove-Item -Recurse -Force $EngineDir }
  New-Item -ItemType Directory -Force -Path (Split-Path $EngineDir -Parent) | Out-Null
  $rc = Native 'git' @('clone', '--recurse-submodules', 'https://github.com/rodrigomatta/s2.cpp.git', $EngineDir)
  if ($rc -ne 0) { throw "git clone failed (exit $rc)." }
}
if (-not (Test-Path (Join-Path $EngineDir 'CMakeLists.txt'))) { throw 's2.cpp clone failed (no CMakeLists.txt).' }

# Patch an alpha-source portability bug: main.cpp uses bare Windows max()/min()
# macros, which cpp-httplib's NOMINMAX suppresses under Clang/MinGW. Rewrite the
# standalone calls to std::max/std::min (idempotent; skips std::max/fmax/.max).
$mainCpp = Join-Path $EngineDir 'src\main.cpp'
if (Test-Path $mainCpp) {
  $c = [System.IO.File]::ReadAllText($mainCpp)
  $c2 = [regex]::Replace($c, '(?<![\w:.])(max|min)\(', 'std::$1(')
  if ($c2 -ne $c) { [System.IO.File]::WriteAllText($mainCpp, $c2); Log 'Patched main.cpp (bare max/min -> std::max/std::min).' }
}

# --- 5) configure + build (CPU, Release, Clang + Ninja) ----------------------
$BuildDir = Join-Path $EngineDir 'build'
Log 'Configuring (CMake / Ninja / Clang, CPU Release)...'
$rc = Native $CmakeExe.FullName @(
  '-S', $EngineDir, '-B', $BuildDir, '-G', 'Ninja',
  '-DCMAKE_BUILD_TYPE=Release',
  '-DCMAKE_C_FLAGS=-D_WIN32_WINNT=0x0A00',
  '-DCMAKE_CXX_FLAGS=-D_WIN32_WINNT=0x0A00',
  "-DCMAKE_MAKE_PROGRAM=$($Ninja.FullName.Replace('\','/'))",
  "-DCMAKE_C_COMPILER=$($Clang.FullName.Replace('\','/'))",
  "-DCMAKE_CXX_COMPILER=$($ClangXX.Replace('\','/'))"
)
if ($rc -ne 0) { throw "CMake configure failed (exit $rc)." }

Log 'Building (this can take several minutes)...'
$rc = Native $CmakeExe.FullName @('--build', $BuildDir, '--config', 'Release')
if ($rc -ne 0) { throw "Build failed (exit $rc)." }

# --- 6) locate s2 + record it ------------------------------------------------
$S2 = Get-ChildItem -Path $BuildDir -Recurse -Include 's2.exe','s2' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $S2) { throw 'Build finished but the s2 binary was not found under build/.' }
Log "ENGINE BUILT: $($S2.FullName)"

# Bundle the Clang/LLVM runtime DLLs next to s2.exe so it runs standalone
# (otherwise STATUS_DLL_NOT_FOUND, 0xC0000135). UCRT api-ms-win-crt-* come from Windows.
foreach ($d in @('libc++.dll','libunwind.dll','libomp.dll','libwinpthread-1.dll')) {
  $src = Join-Path $LlvmBin $d
  if (Test-Path $src) { Copy-Item $src -Destination $S2.DirectoryName -Force; Log "Bundled $d" }
}

$cfg = @{}
if (Test-Path $SettingsF) { try { (Get-Content $SettingsF -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $cfg[$_.Name] = $_.Value } } catch {} }
$cfg['s2Bin'] = $S2.FullName
[System.IO.File]::WriteAllText($SettingsF, ($cfg | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
Log "Wrote engine path to $SettingsF"
Log 'DONE'
