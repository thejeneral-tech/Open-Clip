#!/usr/bin/env bash
exec konsole --separate -p tabtitle=OpenClip -e bash -c '
export BROWSER=firefox
cd /shared/Openclip/OpenClip/OpenClip
python3.12 launch.py
echo
read -rn1 -p "[OpenClip closed] Press any key to close this window…"
'
