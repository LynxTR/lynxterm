# shared: variables and helpers
# name: Deno
# description: Official installer from deno.land, in ~/.deno for this user
PATH=$HOME/.deno/bin:$PATH
detect() {
command -v deno >/dev/null || return 1
cur=$(deno --version | sed -n '1s/^deno \([0-9.]*\).*/\1/p')
echo "Deno $cur"
latest=$(curl -fsSI --max-time 5 https://github.com/denoland/deno/releases/latest | grep -i '^location:' | sed 's|.*/tag/v||' | tr -d '\r ')
[ -n "$latest" ] && [ "$latest" != "$cur" ] && echo "update: $latest"
return 0
}
install() {
for t in curl unzip; do command -v $t >/dev/null || { echo "Needs $t"; return 2; }; done
curl -fsSL https://deno.land/install.sh | sh || return 2
echo "Deno in ~/.deno. Say yes if the installer offers to add it to your shell profile."
}
upgrade() {
deno upgrade
}
uninstall() {
rm -rf "$HOME/.deno"
echo "Removed ~/.deno. The deno lines in ~/.bashrc or ~/.zshrc can go too."
}
"$@"
