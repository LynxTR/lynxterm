# shared: variables and helpers
# name: Bun
# description: Official installer from bun.sh, in ~/.bun for this user
PATH=$HOME/.bun/bin:$PATH
detect() {
command -v bun >/dev/null || return 1
cur=$(bun --version)
echo "Bun $cur"
latest=$(curl -fsSI --max-time 5 https://github.com/oven-sh/bun/releases/latest | grep -i '^location:' | sed 's|.*/tag/bun-v||' | tr -d '\r ')
[ -n "$latest" ] && [ "$latest" != "$cur" ] && echo "update: $latest"
return 0
}
install() {
for t in curl bash unzip; do command -v $t >/dev/null || { echo "Needs $t"; return 2; }; done
curl -fsSL https://bun.sh/install | bash || return 2
echo "Bun in ~/.bun. The installer added it to your shell profile; open a new terminal."
}
upgrade() {
bun upgrade
}
uninstall() {
rm -rf "$HOME/.bun"
echo "Removed ~/.bun. The bun lines in ~/.bashrc or ~/.zshrc can go too."
}
"$@"
