# shared: variables and helpers
# name: PHP
# description: Command-line PHP from the distro's packages: apt or dnf
PATH=$PATH:/usr/sbin:/sbin
# apt, dnf, or empty.
pm() {
  if command -v apt-get >/dev/null; then echo apt
  elif command -v dnf >/dev/null; then echo dnf
  fi
}
detect() {
command -v php >/dev/null || return 1
php --version 2>/dev/null | head -1 | cut -d' ' -f1-2
}
install() {
case $(pm) in
  apt) sudo apt-get update && sudo apt-get install -y php-cli ;;
  dnf) sudo dnf install -y php-cli ;;
  *) echo "Only apt and dnf here; use your package manager"; return 2 ;;
esac
}
upgrade() {
case $(pm) in
  apt) sudo apt-get update && sudo apt-get install -y --only-upgrade php-cli ;;
  dnf) sudo dnf upgrade -y php-cli ;;
  *) echo "Only apt and dnf here"; return 2 ;;
esac
}
uninstall() {
case $(pm) in
  apt) sudo apt-get remove -y php-cli ;;
  dnf) sudo dnf remove -y php-cli ;;
  *) echo "Only apt and dnf here"; return 2 ;;
esac
}
"$@"
