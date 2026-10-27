# >>> lynxterm shell integration >>>
# Prompt start/end (OSC 133), working directory (OSC 7): Lynxterm reads exact command
# line, suggests completions. Exit status, git branch (OSC 633) feed command blocks;
# block header lines print only in sessions Lynxterm set up itself.
# To remove: delete everything between these two marker lines.
case $- in *i*)
  # Keeps $? so prompt themes see real status.
  __lynxterm_keep() { __lynxterm_status=$?; return $__lynxterm_status; }
  # Exit status (if command ran), directory, then next block's header line, which
  # Lynxterm draws over. After command, empty row first: gap between blocks.
  __lynxterm_report() {
    printf '\033]133;D%s\007\033]7;file://%s%s\007' "${__lynxterm_ran:+;$__lynxterm_status}" "$1" "$PWD"
    printf '\033]633;P;Branch=%s\007' "$(git symbolic-ref --short -q HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null)"
    if [ -n "$__lynxterm_blocks" ] && [ -n "$__lynxterm_ran$__lynxterm_first" ]; then
      [ -n "$__lynxterm_ran" ] && printf '\n'
      printf '\033]633;H\007\n'
    fi
    __lynxterm_ran= __lynxterm_first=
  }
  if [ -n "$BASH_VERSION" ]; then
    __lynxterm_prompt() {
      __lynxterm_report "${HOSTNAME:-}"
      # Re-wrap PS1 if prompt theme rebuilt it.
      case "$PS1" in *'133;B'*) ;; *) PS1="\[\033]133;A\007\]$PS1\[\033]133;B\007\]" ;; esac
    }
    # Status hook first, before theme changes $?; prompt hook last, so wrap survives
    # theme. Each added once: block may run twice.
    case "$PROMPT_COMMAND" in *__lynxterm_keep*) ;; *) PROMPT_COMMAND="__lynxterm_keep;$PROMPT_COMMAND" ;; esac
    case "$PROMPT_COMMAND" in *__lynxterm_prompt*) ;; *) PROMPT_COMMAND="${PROMPT_COMMAND%;};__lynxterm_prompt" ;; esac
    # PS0 prints at command start; empty substring sets "ran" flag. Older block set
    # PS0 to bare marker: strip it.
    case "$PS0" in *__lynxterm_ran*) ;; *)
      PS0="${PS0//$'\033]133;C\007'/}"'${PS1:0:$((__lynxterm_ran=1,0))}'$'\033]133;C\007' ;;
    esac
  elif [ -n "$ZSH_VERSION" ]; then
    __lynxterm_precmd() {
      __lynxterm_report "${HOST:-}"
      case "$PS1" in *'133;B'*) ;; *) PS1="%{$(printf '\033]133;A\007')%}$PS1%{$(printf '\033]133;B\007')%}" ;; esac
    }
    __lynxterm_preexec() { __lynxterm_ran=1; printf '\033]133;C\007'; }
    # eval hides zsh array syntax from plain sh parsers
    eval 'precmd_functions=(__lynxterm_keep ${precmd_functions:#__lynxterm_*} __lynxterm_precmd)
      preexec_functions=(${preexec_functions:#__lynxterm_*} __lynxterm_preexec)'
  fi
;; esac
# <<< lynxterm shell integration <<<
