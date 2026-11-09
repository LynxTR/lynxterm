# shared: variables and helpers
# name: Node.js LTS
# description: Current LTS release from nodejs.org, in ~/.local/node for this user
PATH=$HOME/.local/bin:$PATH
DIR=$HOME/.local/node
case $(uname -m) in
  x86_64) ARCH=x64 ;;
  aarch64) ARCH=arm64 ;;
  *) ARCH= ;;
esac
# Newest LTS, like v22.11.0; empty when offline. index.tab: one release a line, newest first,
# column 10 the LTS codename or "-".
latest_lts() {
  curl -fsSL --max-time 10 https://nodejs.org/dist/index.tab 2>/dev/null |
    awk 'NR > 1 && $10 != "-" { print $1; exit }'
}
detect() {
command -v node >/dev/null || return 1
cur=$(node --version)
echo "Node.js $cur"
latest=$(latest_lts)
[ -n "$latest" ] && [ "$latest" != "$cur" ] && echo "update: $latest"
return 0
}
install() {
command -v curl >/dev/null || { echo "Needs curl"; return 2; }
[ -n "$ARCH" ] || { echo "No Node.js build for $(uname -m)"; return 2; }
v=$(latest_lts)
[ -n "$v" ] || { echo "Couldn't look up the latest LTS version"; return 2; }
mkdir -p "$HOME/.local/bin" && rm -rf "$DIR" && mkdir -p "$DIR" || return 2
curl -fL "https://nodejs.org/dist/$v/node-$v-linux-$ARCH.tar.gz" | tar -xz -C "$DIR" --strip-components=1 || return 2
for b in node npm npx corepack; do ln -sf "$DIR/bin/$b" "$HOME/.local/bin/$b"; done
echo "Node.js $v in ~/.local/node. ~/.local/bin is on PATH in new login shells on most distros."
}
upgrade() {
install
}
uninstall() {
rm -rf "$DIR"
for b in node npm npx corepack; do rm -f "$HOME/.local/bin/$b"; done
echo "Removed. Global npm packages went with it; projects keep their own node_modules."
}
"$@"
