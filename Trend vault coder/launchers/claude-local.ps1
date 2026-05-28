$launcherDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $launcherDir
$cliPath = Join-Path $repoRoot "vendor\\claude-code-bundle\\cli.js"

if (-not (Test-Path -LiteralPath $cliPath)) {
  Write-Error "Claude Code bundle not found at $cliPath"
  exit 1
}

& node $cliPath @args
exit $LASTEXITCODE
