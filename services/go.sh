# shared: variables and helpers
# name: Go
# description: Latest release from go.dev, in ~/.local/go for this user
PATH=$HOME/.local/bin:$PATH
DIR=$HOME/.local/go
case $(uname -m) in
  x86_64) ARCH=amd64 ;;
  aarch64) ARCH=arm64 ;;
  *) ARCH= ;;
esac
# Newest release, like go1.23.4; empty when offline.
latest_go() {
  curl -fsSL --max-time 5 'https://go.dev/VERSION?m=text' | head -1
}
detect() {
command -v go >/dev/null || return 1
cur=$(go version | cut -d' ' -f3)
echo "Go ${cur#go}"
latest=$(latest_go)
[ -n "$latest" ] && [ "$latest" != "$cur" ] && echo "update: ${latest#go}"
return 0
}
install() {
command -v curl >/dev/null || { echo "Needs curl"; return 2; }
[ -n "$ARCH" ] || { echo "No Go build for $(uname -m)"; return 2; }
v=$(latest_go)
[ -n "$v" ] || { echo "Couldn't look up the latest Go version"; return 2; }
mkdir -p "$HOME/.local/bin" && rm -rf "$DIR" || return 2
curl -fL "https://go.dev/dl/$v.linux-$ARCH.tar.gz" | tar -xz -C "$HOME/.local" || return 2
for b in go gofmt; do ln -sf "$DIR/bin/$b" "$HOME/.local/bin/$b"; done
echo "Go ${v#go} in ~/.local/go. ~/.local/bin is on PATH in new login shells on most distros."
}
upgrade() {
install
}
uninstall() {
rm -rf "$DIR"
for b in go gofmt; do rm -f "$HOME/.local/bin/$b"; done
echo "Removed ~/.local/go. Your code and module cache in ~/go stay."
}
"$@"
