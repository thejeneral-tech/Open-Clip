$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$cliPath = Join-Path $repoRoot "package\\cli.js"

if (-not (Test-Path -LiteralPath $cliPath)) {
  Write-Error "Claude Code bundle not found at $cliPath"
  exit 1
}

& node $cliPath @args
exit $LASTEXITCODE
