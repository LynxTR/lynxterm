# shared: variables and helpers
# name: SSH key-only sign-in
# description: Password sign-in turned off once your key works, for every user on this server
# why: Passwords can be guessed from anywhere; keys can't
# fix: Turn off passwords
PATH=$PATH:/usr/sbin:/sbin
CONF=/etc/ssh/sshd_config
# sshd keeps first value read: block at top beats later lines and Include. Match blocks still
# override for their users (see passwords). Both keyboard-interactive names: one setting since
# OpenSSH 8.7, two before, and either lets PAM ask for the password.
BLOCK='# >>> lynxterm key-only sign-in
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
# <<< lynxterm key-only sign-in'
# Root without sudo (Proxmox, minimal images): run as is.
as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
}
# File as sshd reads it: Include files in place, nested too ($2 depth; sshd stops at 16).
# READ=as_root in terminal functions only: background check never sudo, refused sudo lands in
# auth log. File there but not ours to read (RHEL sshd_config is 600): "unreadable".
expand() {
  [ "${2:-0}" -lt 16 ] || return 0
  if [ -n "$READ" ]; then $READ cat "$1" 2>/dev/null
  elif [ -r "$1" ]; then cat "$1"
  elif [ -e "$1" ]; then echo unreadable
  fi | while read -r k rest; do
    case $(printf %s "$k" | tr A-Z a-z) in
      include) for f in $rest; do expand "$f" $((${2:-0} + 1)); done ;;
      *) echo "$k $rest" ;;
    esac
  done
}
# cd: sshd resolves relative Include against config dir.
config() {
  (cd "${CONF%/*}" 2>/dev/null; expand "$CONF")
}
# no, yes, partly (Match block allows passwords for some) or unknown. Keyboard-interactive
# asks password through PAM: counts as password sign-in. Both default yes.
passwords() {
  config | awk '{ sub(/^[ \t]+/, ""); if ($0 == "" || $0 ~ /^#/) next
      k = tolower($0); sub(/[ \t=].*/, "", k)
      v = tolower($0); sub(/^[^ \t=]+[ \t]*=?[ \t]*/, "", v); sub(/[ \t].*/, "", v)
      if (k == "match") m = 1
      else if (k == "unreadable") { if (!m && (pa == "" || ki == "")) u = 1 }
      else if (k == "passwordauthentication") { if (m) p = p || v == "yes"; else if (pa == "") pa = v }
      else if (k == "kbdinteractiveauthentication" || k == "challengeresponseauthentication") {
        if (m) p = p || v == "yes"; else if (ki == "") ki = v }
    }
    END { if (u) print "unknown"
      else if (pa != "no" || ki != "no") print "yes"
      else if (p) print "partly"
      else print "no" }'
}
# sshd_config minus our block. Fails if unreadable: partial file never written.
plain() {
  cfg=$(as_root cat "$CONF") && [ -n "$cfg" ] || { echo "Couldn't read $CONF"; return 2; }
  printf '%s\n' "$cfg" | awk '/^# >>> lynxterm key-only/ { skip = 1 } !skip { print } /^# <<< lynxterm key-only/ { skip = 0 }'
}
# Copy keeps owner, mode, SELinux label. Read back: short write (disk full) never passes.
put() {
  t=$(mktemp) || return 2
  printf '%s\n' "$1" > "$t" && as_root cp "$t" "$CONF" && as_root cmp -s "$t" "$CONF"
  r=$?; rm -f "$t"; return $r
}
# Root shell text, $0 reload or restart: systemd, OpenRC, SysV, then HUP by pid file.
SVC='systemctl $0 ssh 2>/dev/null || systemctl $0 sshd 2>/dev/null || rc-service sshd $0 2>/dev/null || service ssh $0 2>/dev/null || service sshd $0 2>/dev/null || { [ $0 = reload ] && kill -HUP "$(cat /run/sshd.pid /var/run/sshd.pid 2>/dev/null | head -1)" 2>/dev/null; }'
reload() {
  as_root sh -c "$SVC" reload
}
apply() {
  as_root cp -p "$CONF" "$CONF.before-lynxterm" || return 2
  if ! put "$1"; then m="Couldn't write $CONF"
  elif ! as_root sshd -t; then m="sshd rejected the change (above)"
  elif ! reload; then m="sshd didn't reload"
  else return 0
  fi
  as_root cp -p "$CONF.before-lynxterm" "$CONF"
  echo "$m, so it's back as it was"; return 2
}
# Dead man's switch. Root timer, detached from this session, puts config back and reloads
# (restarts if sshd died) unless check wrote ok from a new key sign-in. Unreadable or missing
# file counts as not ok: lost network, dead sshd, refused key all end with passwords back on.
WAIT=120
PENDING=$HOME/.lynxterm/ssh-key-only.pending
TIMER='sleep "$0"; grep -q ok "$1" 2>/dev/null || { cp -p "$2.before-lynxterm" "$2"; sh -c "$3" reload || sh -c "$3" restart; }; rm -f "$1"'
# sudo in foreground (may ask password); only timer goes to background. HUP ignored before
# fork, not by nohup after: tab closing right now must not kill timer.
arm() {
  mkdir -p "${PENDING%/*}" && echo pending > "$PENDING" &&
    as_root sh -c 'trap "" HUP; sh -c "$0" "$@" </dev/null >/dev/null 2>&1 &' "$TIMER" "$WAIT" "$PENDING" "$CONF" "$SVC"
}
# After a failed step in fix: old config back, or say plainly it isn't.
undo() {
  as_root cp -p "$CONF.before-lynxterm" "$CONF" && reload && echo "$1, so it's back as it was" ||
    echo "$1, and putting it back failed: passwords are off. Check a new sign-in works before closing this tab"
}
detect() {
command -v sshd >/dev/null || return 1
ssh -V 2>&1 | cut -d' ' -f1 | tr -d ,
}
preflight() {
[ "$(uname)" = Linux ] || { echo "Linux servers only"; return 2; }
[ "$LYNXTERM_AUTH" = publickey ] || { echo "Sign in with a key first, or this locks you out: switch the host to a key, then try again"; return 2; }
grep -q . "$HOME/.ssh/authorized_keys" 2>/dev/null || { echo "No key in ~/.ssh/authorized_keys"; return 2; }
[ "$(id -u)" = 0 ] || command -v sudo >/dev/null || { echo "Needs sudo, or sign in as root"; return 2; }
# One timer at a time: second run would overwrite backup first timer restores.
[ -z "$(find "$PENDING" -mmin -3 2>/dev/null)" ] || { echo "Turned off a moment ago and still being confirmed: try again in a few minutes"; return 2; }
echo "Password sign-in stops for every user on this server, root too"
echo "Your key is the way in after this: keep a copy (Keychain, Export) or a second key on the server"
echo "Undone by itself in 2 minutes unless a new sign-in with your key works"
return 1
}
check() {
# LYNXTERM_FRESH: app opened this connection just now. Key got in after fix: timer stands down.
[ -n "$LYNXTERM_FRESH" ] && [ "$LYNXTERM_AUTH" = publickey ] && [ -e "$PENDING" ] && echo ok > "$PENDING"
# Fix not confirmed (reused connection, or key didn't get in): timer may still undo it.
[ -n "$(find "$PENDING" -mmin -3 2>/dev/null)" ] && ! grep -q ok "$PENDING" && { echo "Off, but not confirmed yet: undone by itself unless a new sign-in with your key works"; return 1; }
case $(passwords) in
  no) echo "Key only, passwords off" ;;
  partly) echo "Off, but a Match rule still allows passwords for some"; return 1 ;;
  unknown) echo "Can't read all of sshd's settings without sudo"; return 3 ;;
  *) echo "Password sign-in on"; return 1 ;;
esac
}
fix() {
preflight; [ $? -lt 2 ] || return 2
p=$(plain) || { echo "$p"; return 2; }
apply "$BLOCK
$p" || return
case $(READ=as_root passwords) in
  no) m="Passwords off."; r=0 ;;
  partly) m="Passwords off, but a Match rule in sshd's config still allows them for some."; r=1 ;;
  *) undo "Couldn't see the change take effect"; return 2 ;;
esac
arm || { undo "Couldn't set the undo timer"; return 2; }
echo "$m LynxTerm now signs in again with your key. If that fails, this server turns passwords back on by itself in 2 minutes."
return $r
}
uninstall() {
p=$(plain) || { echo "$p"; return 2; }
# Fix still pending: its timer would restore key-only from backup. Stand it down first.
[ -e "$PENDING" ] && echo ok > "$PENDING"
apply "$p" || return
echo "Password sign-in allowed again"
}
"$@"
