$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $repoRoot "trendvault-coder-launcher.cjs") @args
exit $LASTEXITCODE
