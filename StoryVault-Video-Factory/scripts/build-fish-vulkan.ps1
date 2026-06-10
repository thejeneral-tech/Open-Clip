# Attempt a Vulkan (GPU) build of the s2.cpp engine for faster generation on the
# Intel Iris Xe iGPU. Reuses the portable CMake + llvm-mingw (Clang) + Ninja from
# the CPU build, plus the LunarG Vulkan SDK (for glslc + headers + lib). Builds
# into a SEPARATE build-vk dir so the working CPU binary is preserved. Does NOT
# switch the active engine — that's decided after a speed/correctness test.
# ASCII-only for robust PowerShell parsing.
$ErrorActionPreference = 'Stop'
$Root      = Split-Path $PSScriptRoot -Parent
$BinDir    = Join-Path $Root 'bin'
$VkDir     = Join-Path $BinDir 'VulkanSDK'
$EngineDir = Join-Path $Root 'data\models\s2.cpp'
$BuildVk   = Join-Path $EngineDir 'build-vk'
$VK_VER    = '1.4.350.0'

function Log($m) { Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }
function Native($exe, [string[]]$a) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & $exe @a 2>&1 | ForEach-Object { Log $_ } } finally { $ErrorActionPreference = $prev }
  return $LASTEXITCODE
}
function Download($url, $dest) {
  Log "Downloading $url"
  $old = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing; return $true }
  catch { Log "Download failed: $($_.Exception.Message)"; return $false }
  finally { $ProgressPreference = $old }
}

# --- locate the toolchain from the CPU build ---------------------------------
$CmakeExe = Get-ChildItem -Path (Join-Path $BinDir 'cmake') -Recurse -Filter cmake.exe -ErrorAction SilentlyContinue | Select-Object -First 1
$Clang    = Get-ChildItem -Path (Join-Path $BinDir 'llvm-mingw') -Recurse -Filter clang.exe -ErrorAction SilentlyContinue | Select-Object -First 1
$Ninja    = Get-ChildItem -Path (Join-Path $BinDir 'ninja') -Recurse -Filter ninja.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not ($CmakeExe -and $Clang -and $Ninja)) { throw 'Toolchain not found. Run scripts\build-fish-engine.ps1 (CPU build) first.' }
$LlvmBin = $Clang.DirectoryName
$ClangXX = Join-Path $LlvmBin 'clang++.exe'
Log "Toolchain OK (cmake/clang/ninja)."

# --- Vulkan SDK (glslc + headers + vulkan-1 lib) -----------------------------
$Glslc = Get-ChildItem -Path $VkDir -Recurse -Filter glslc.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $Glslc) {
  $inst = Join-Path $env:TEMP "vulkansdk-windows-X64-$VK_VER.exe"
  if (-not (Test-Path $inst) -or (Get-Item $inst).Length -lt 1000000) {
    if (-not (Download "https://sdk.lunarg.com/sdk/download/$VK_VER/windows/vulkansdk-windows-X64-$VK_VER.exe" $inst)) { throw 'Could not download the Vulkan SDK installer.' }
  }
  Log 'Installing Vulkan SDK to a user folder (no admin)...'
  New-Item -ItemType Directory -Force -Path $VkDir | Out-Null
  # LunarG uses a Qt Installer Framework EXE; silent install to a custom root.
  $rc = Native $inst @('--root', $VkDir, '--accept-licenses', '--default-answer', '--confirm-command', 'install')
  if ($rc -ne 0) { Log "Installer returned $rc (continuing to probe for files)." }
  $Glslc = Get-ChildItem -Path $VkDir -Recurse -Filter glslc.exe -ErrorAction SilentlyContinue | Select-Object -First 1
}
if (-not $Glslc) { throw 'Vulkan SDK install failed: glslc.exe not found. The SDK installer may need a desktop/admin; install it manually from vulkan.lunarg.com, then re-run.' }
$VkRoot = Split-Path $Glslc.DirectoryName -Parent  # <sdk>\Bin\glslc.exe -> <sdk>
$VkInc  = Join-Path $VkRoot 'Include'
$VkLib  = Join-Path $VkRoot 'Lib\vulkan-1.lib'
Log "Vulkan SDK: $VkRoot"
Log "  glslc:   $($Glslc.FullName)"
Log "  headers: $VkInc  (exists=$(Test-Path (Join-Path $VkInc 'vulkan\vulkan.h')))"
Log "  lib:     $VkLib  (exists=$(Test-Path $VkLib))"

$env:VULKAN_SDK = $VkRoot
$env:Path = "$($Glslc.DirectoryName);$LlvmBin;$($CmakeExe.DirectoryName);$($Ninja.DirectoryName);$env:Path"

# --- configure + build (Vulkan, into build-vk) -------------------------------
if (Test-Path $BuildVk) { Remove-Item -Recurse -Force $BuildVk }
Log 'Configuring with -DS2_VULKAN=ON (Clang/Ninja)...'
$rc = Native $CmakeExe.FullName @(
  '-S', $EngineDir, '-B', $BuildVk, '-G', 'Ninja',
  '-DCMAKE_BUILD_TYPE=Release',
  '-DS2_VULKAN=ON',
  '-DCMAKE_C_FLAGS=-D_WIN32_WINNT=0x0A00',
  '-DCMAKE_CXX_FLAGS=-D_WIN32_WINNT=0x0A00',
  "-DCMAKE_MAKE_PROGRAM=$($Ninja.FullName.Replace('\','/'))",
  "-DCMAKE_C_COMPILER=$($Clang.FullName.Replace('\','/'))",
  "-DCMAKE_CXX_COMPILER=$($ClangXX.Replace('\','/'))",
  "-DVulkan_GLSLC_EXECUTABLE=$($Glslc.FullName.Replace('\','/'))",
  "-DVulkan_INCLUDE_DIR=$($VkInc.Replace('\','/'))",
  "-DVulkan_LIBRARY=$($VkLib.Replace('\','/'))"
)
if ($rc -ne 0) { throw "CMake configure (Vulkan) failed (exit $rc). The MinGW/Clang toolchain may not link the MSVC Vulkan lib." }

Log 'Building (Vulkan) - this can take several minutes...'
$rc = Native $CmakeExe.FullName @('--build', $BuildVk, '--config', 'Release')
if ($rc -ne 0) { throw "Vulkan build failed (exit $rc). See the log; the CPU build is unaffected." }

$S2 = Get-ChildItem -Path $BuildVk -Recurse -Include 's2.exe','s2' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $S2) { throw 'Vulkan build finished but s2 binary not found.' }
foreach ($d in @('libc++.dll','libunwind.dll','libomp.dll','libwinpthread-1.dll')) {
  $src = Join-Path $LlvmBin $d
  if (Test-Path $src) { Copy-Item $src -Destination $S2.DirectoryName -Force }
}
Log "VULKAN ENGINE BUILT: $($S2.FullName)"
Log 'DONE (not yet active - will be speed-tested before switching).'
