$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $repoRoot "claw-dev-launcher.js") @args
exit $LASTEXITCODE
