# OpenClip launcher (Windows / PowerShell) — no Docker.
#
# A thin, native entry point for the cross-platform control panel in launch.py.
# It is the Windows twin of launch.sh: run it with no arguments for the
# interactive menu, or pass any launch.py subcommand straight through.
#
#   .\launch.ps1            # interactive menu
#   .\launch.ps1 doctor     # check prerequisites (Python / Node / FFmpeg / Ollama / ports)
#   .\launch.ps1 setup      # create venv, install deps, init the database
#   .\launch.ps1 up         # start the whole stack, wait, open the app
#   .\launch.ps1 status     # service + health overview
#   .\launch.ps1 logs api   # tail a service log (api | worker | frontend | ollama | fish)
#   .\launch.ps1 down       # stop everything
#
# launch.py is pure standard library, so no virtualenv is needed just to run
# this — it builds the backend venv itself on `setup`. Python discovery mirrors
# scripts/setup.ps1.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$py = if (Get-Command py -ErrorAction SilentlyContinue) { "py" }
      elseif (Get-Command python -ErrorAction SilentlyContinue) { "python" }
      else { Write-Error "Python 3.10-3.12 is required to run OpenClip. https://www.python.org/downloads/"; exit 1 }

# Pass every argument straight through to the launcher and propagate its exit code.
& $py launch.py @args
exit $LASTEXITCODE
