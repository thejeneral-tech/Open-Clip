#compdef trendvault-ai trendvault-ai-backup trendvault-ai-calendar trendvault-ai-contacts trendvault-ai-cookbook trendvault-ai-docs trendvault-ai-gallery trendvault-ai-mail trendvault-ai-mcp trendvault-ai-memory trendvault-ai-notes trendvault-ai-personal trendvault-ai-preset trendvault-ai-research trendvault-ai-sessions trendvault-ai-signature trendvault-ai-skills trendvault-ai-tasks trendvault-ai-theme trendvault-ai-webhook
# Zsh tab-completion for the trendvault-ai umbrella + sub-CLIs.
#
# Drop in any directory on $fpath, e.g.:
#     fpath=(/path/to/trendvault-ai-ui/scripts/_completion $fpath)
#     autoload -U compinit; compinit
#
# Then `trendvault-ai <tab>` completes subcommands; `trendvault-ai mail <tab>`
# completes mail subcommands; `trendvault-ai-mail <tab>` works the same.

_trendvault_ai_scripts_dir() {
    local self="${(%):-%x}"
    while [[ -L "$self" ]]; do self="$(readlink "$self")"; done
    cd "${self:h}/.." && pwd
}

typeset -gA _trendvault_ai_subs

_trendvault_ai_refresh() {
    _trendvault_ai_subs=()
    local dir="$(_trendvault_ai_scripts_dir)"
    local py="$dir/../venv/bin/python"
    [[ -x "$py" ]] || py="$(command -v python3)"
    local f sub help_out commands
    for f in "$dir"/trendvault-ai-*; do
        [[ -x "$f" ]] || continue
        case "$f" in
            *.bak|*.pyc|*.pre-*) continue ;;
        esac
        sub="${${f:t}#trendvault-ai-}"
        help_out=$("$py" "$f" --help 2>/dev/null) || continue
        commands=$(echo "$help_out" | grep -oE '\{[a-z0-9_,-]+\}' | head -1 \
            | tr -d '{}' | tr ',' ' ')
        _trendvault_ai_subs[$sub]="$commands"
    done
}

_trendvault-ai() {
    [[ ${#_trendvault_ai_subs} -eq 0 ]] && _trendvault_ai_refresh

    local cmd="${words[1]}"

    if [[ "$cmd" == "trendvault-ai" ]]; then
        if (( CURRENT == 2 )); then
            local -a subs=(${(k)_trendvault_ai_subs} help)
            _describe 'subcommand' subs
            return
        fi
        local sub="${words[2]}"
        if [[ "$sub" == "help" ]] && (( CURRENT == 3 )); then
            local -a subs=(${(k)_trendvault_ai_subs})
            _describe 'subcommand' subs
            return
        fi
        if (( CURRENT == 3 )); then
            local -a sc=(${(s/ /)_trendvault_ai_subs[$sub]})
            _describe 'command' sc
            return
        fi
        return
    fi

    # trendvault-ai-foo <tab>
    local sub="${cmd#trendvault-ai-}"
    if (( CURRENT == 2 )); then
        local -a sc=(${(s/ /)_trendvault_ai_subs[$sub]})
        _describe 'command' sc
        return
    fi
}

_trendvault-ai "$@"
