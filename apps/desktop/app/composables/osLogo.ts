// OS logo on brand color, keyed by /etc/os-release ID (metrics.rs reads it).
// Icon names written in full so Nuxt Icon bundles them.
type Logo = { icon: string; bg: string; dark?: boolean };

const logos: Record<string, Logo> = {
  debian: { icon: "i-simple-icons-debian", bg: "#a81d33" },
  ubuntu: { icon: "i-simple-icons-ubuntu", bg: "#e95420" },
  fedora: { icon: "i-simple-icons-fedora", bg: "#3c6eb4" },
  centos: { icon: "i-simple-icons-centos", bg: "#262577" },
  rocky: { icon: "i-simple-icons-rockylinux", bg: "#10b981" },
  almalinux: { icon: "i-simple-icons-almalinux", bg: "#0f4266" },
  arch: { icon: "i-simple-icons-archlinux", bg: "#1793d1" },
  alpine: { icon: "i-simple-icons-alpinelinux", bg: "#0d597f" },
  rhel: { icon: "i-simple-icons-redhat", bg: "#ee0000" },
  "opensuse-leap": { icon: "i-simple-icons-opensuse", bg: "#73ba25" },
  "opensuse-tumbleweed": { icon: "i-simple-icons-opensuse", bg: "#73ba25" },
  sles: { icon: "i-simple-icons-suse", bg: "#30ba78" },
  amzn: { icon: "i-simple-icons-amazonwebservices", bg: "#ff9900", dark: true },
  linuxmint: { icon: "i-simple-icons-linuxmint", bg: "#87cf3e", dark: true },
  raspbian: { icon: "i-simple-icons-raspberrypi", bg: "#a22846" },
  ol: { icon: "i-simple-icons-oracle", bg: "#c74634" },
  pop: { icon: "i-simple-icons-popos", bg: "#48b9c7", dark: true },
  elementary: { icon: "i-simple-icons-elementary", bg: "#64baff", dark: true },
  endeavouros: { icon: "i-simple-icons-endeavouros", bg: "#7f3fbf" },
  manjaro: { icon: "i-simple-icons-manjaro", bg: "#35bf5c", dark: true },
  gentoo: { icon: "i-simple-icons-gentoo", bg: "#54487a" },
  nixos: { icon: "i-simple-icons-nixos", bg: "#5277c3" },
  kali: { icon: "i-simple-icons-kalilinux", bg: "#557c94" },
  freebsd: { icon: "i-simple-icons-freebsd", bg: "#ab2b28" },
  openbsd: { icon: "i-simple-icons-openbsd", bg: "#f2ca30", dark: true },
  darwin: { icon: "i-simple-icons-apple", bg: "#555555" },
  linux: { icon: "i-simple-icons-linux", bg: "#fcc624", dark: true },
};

/** undefined while OS unknown. */
export const osLogo = (os?: string): Logo | undefined =>
  os ? (logos[os] ?? logos.linux) : undefined;
