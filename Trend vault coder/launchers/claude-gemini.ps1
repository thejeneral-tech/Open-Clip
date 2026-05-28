$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $env:GEMINI_API_KEY) {
  Write-Error "GEMINI_API_KEY is not set. Set it in this shell first."
  exit 1
}

& node (Join-Path $repoRoot "claude-gemini-launcher.js") @args
exit $LASTEXITCODE
