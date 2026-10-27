# Typed into each new session right after shell-integration.sh (see SshTerminal.vue):
# enables block headers, removes typed line from bash history, reports prompt height in
# lines so Lynxterm can replace it.
__lynxterm_blocks=1 __lynxterm_first=1
if [ -n "$BASH_VERSION" ]; then
  # Typed line is script in base64; this is its start, "# >>> ".
  case "$(history 1)" in *IyA+Pj4g*) history -d "$(history 1 | awk '{print $1}')" ;; esac
  if [ "${BASH_VERSINFO[0]}${BASH_VERSINFO[1]}" -ge 44 ]; then
    eval '__lynxterm_p=${PS1@P}'
  else
    __lynxterm_p=${PS1//\\n/$'\n'}
  fi
else
  eval '__lynxterm_p=${(%%)PS1}'
fi
__lynxterm_p=${__lynxterm_p//[^$'\n']/}
printf '\033]633;Ready;%s\007' "${#__lynxterm_p}"
unset __lynxterm_p
