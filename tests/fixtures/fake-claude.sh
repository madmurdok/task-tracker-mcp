#!/bin/sh
# Script-driven stand-in for the `claude` CLI (tests/claudeBg.test.ts).
# FAKE_CLAUDE_LOG     file each invocation appends its cwd and argv to
# FAKE_CLAUDE_BG_OUT  what `claude --bg ...` prints
# FAKE_CLAUDE_BG_ERR  what `claude --bg ...` prints to stderr (TTM-104)
# FAKE_CLAUDE_AGENTS  file whose content `claude agents --json --all` prints
# FAKE_CLAUDE_EXIT    exit status for every invocation (default 0)
if [ -n "$FAKE_CLAUDE_LOG" ]; then
  {
    printf 'cwd=%s\n' "$(pwd -P)"
    for a in "$@"; do printf 'arg=%s\n' "$a"; done
    printf -- '--\n'
  } >>"$FAKE_CLAUDE_LOG"
fi
case "$1" in
  --version) echo "9.9.9 (Claude Code)" ;;
  --bg)
    printf '%s\n' "$FAKE_CLAUDE_BG_OUT"
    if [ -n "$FAKE_CLAUDE_BG_ERR" ]; then printf '%s\n' "$FAKE_CLAUDE_BG_ERR" >&2; fi
    ;;
  agents) cat "$FAKE_CLAUDE_AGENTS" ;;
  stop) echo "stopped $2" ;;
  *) echo "fake claude: unexpected $1" >&2; exit 64 ;;
esac
exit "${FAKE_CLAUDE_EXIT:-0}"
