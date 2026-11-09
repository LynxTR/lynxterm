# shared: variables and helpers
# name: Rust
# description: Stable toolchain via rustup, in ~/.cargo and ~/.rustup for this user
PATH=$HOME/.cargo/bin:$PATH
detect() {
command -v rustc >/dev/null || return 1
cur=$(rustc --version | cut -d' ' -f2)
echo "rustc $cur"
latest=$(rustup check 2>/dev/null | sed -n 's/^stable.*-> \([0-9.]*\).*/\1/p' | head -1)
[ -n "$latest" ] && [ "$latest" != "$cur" ] && echo "update: $latest"
return 0
}
install() {
command -v curl >/dev/null || { echo "Needs curl"; return 2; }
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y || return 2
echo "Rust in ~/.cargo/bin; rustup added it to your shell profile. Building needs a C linker: gcc or clang."
}
upgrade() {
rustup update stable
}
uninstall() {
rustup self uninstall -y
}
"$@"
