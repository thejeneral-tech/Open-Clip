#!/usr/bin/env bash
# Tab-completion for the `trendvault-ai` umbrella + every `trendvault-ai-*` CLI.
#
# Source from your shell rc:
#     source /path/to/trendvault-ai-ui/scripts/_completion/trendvault-ai.bash
#
# Or wire it once per machine:
#     sudo install -m 644 trendvault-ai.bash /etc/bash_completion.d/trendvault-ai
#
# What it does:
#   - On the first word after `trendvault-ai`, complete with the list of
#     subcommands (`mail`, `calendar`, ...).
#   - On subsequent words, complete with the subcommand's first-token
#     subcommands (`list`, `show`, ...) which we cache by parsing the
#     tool's own --help output. Updates lazily; refresh by running
#     `_trendvault_ai_refresh_cache`.
#   - Same completion works for the individual `trendvault-ai-foo` scripts.

_trendvault_ai_scripts_dir() {
    # Resolve the scripts/ dir from the script that sources us. We assume
    # the user sourced the file directly out of scripts/_completion/.
    local self="${BASH_SOURCE[0]}"
    while [ -L "$self" ]; do self=$(readlink "$self"); done
    cd "$(dirname "$self")/.." && pwd
}

declare -A _TRENDVAULT_AI_SUBS_CACHE=()

_trendvault_ai_refresh_cache() {
    local dir="$(_trendvault_ai_scripts_dir)"
    _TRENDVAULT_AI_SUBS_CACHE=()
    # Prefer the project venv's Python so deps (bcrypt, sqlalchemy, ...)
    # resolve. Falls back to system `python3` for container installs.
    local py="$dir/../venv/bin/python"
    [ -x "$py" ] || py="$(command -v python3)"
    local f
    for f in "$dir"/trendvault-ai-*; do
        [ -x "$f" ] || continue
        case "$f" in *.bak|*.pyc|*.pre-*) continue ;; esac
        local name="$(basename "$f")"
        local sub="${name#trendvault-ai-}"
        local help_out
        help_out=$("$py" "$f" --help 2>/dev/null) || continue
        local commands
        commands=$(echo "$help_out" | grep -oE '\{[a-z0-9_,-]+\}' | head -1 \
            | tr -d '{}' | tr ',' ' ')
        _TRENDVAULT_AI_SUBS_CACHE[$sub]="$commands"
    done
}

_trendvault_ai_complete() {
    [ ${#_TRENDVAULT_AI_SUBS_CACHE[@]} -eq 0 ] && _trendvault_ai_refresh_cache

    local cur="${COMP_WORDS[COMP_CWORD]}"
    local cmd="${COMP_WORDS[0]}"

    # `trendvault-ai <tab>` → list every subcommand
    if [ "$cmd" = "trendvault-ai" ]; then
        if [ "$COMP_CWORD" -eq 1 ]; then
            local subs="${!_TRENDVAULT_AI_SUBS_CACHE[@]} help"
            COMPREPLY=($(compgen -W "$subs" -- "$cur"))
            return 0
        fi
        # `trendvault-ai foo <tab>` — complete with foo's own subcommands
        local sub="${COMP_WORDS[1]}"
        # `trendvault-ai help <tab>` lists every subcommand
        if [ "$sub" = "help" ] && [ "$COMP_CWORD" -eq 2 ]; then
            COMPREPLY=($(compgen -W "${!_TRENDVAULT_AI_SUBS_CACHE[*]}" -- "$cur"))
            return 0
        fi
        if [ "$COMP_CWORD" -eq 2 ]; then
            COMPREPLY=($(compgen -W "${_TRENDVAULT_AI_SUBS_CACHE[$sub]}" -- "$cur"))
            return 0
        fi
        return 0
    fi

    # Direct `trendvault-ai-foo <tab>` (no umbrella)
    local sub="${cmd#trendvault-ai-}"
    if [ "$COMP_CWORD" -eq 1 ]; then
        COMPREPLY=($(compgen -W "${_TRENDVAULT_AI_SUBS_CACHE[$sub]}" -- "$cur"))
        return 0
    fi
}

# Register the completion for every trendvault-ai-* script + the umbrella.
complete -F _trendvault_ai_complete trendvault-ai
for f in "$(_trendvault_ai_scripts_dir)"/trendvault-ai-*; do
    [ -x "$f" ] || continue
    case "$f" in *.bak|*.pyc|*.pre-*) continue ;; esac
    complete -F _trendvault_ai_complete "$(basename "$f")"
done
