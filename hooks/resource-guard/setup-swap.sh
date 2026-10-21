#!/usr/bin/env bash
# Mac-like swap for Linux: compressed swap in RAM (zram) first, then swap
# files on disk that grow and shrink by themselves (swapspace). Retires fixed
# swap *files* listed in /etc/fstab (swap partitions are left alone, zram and
# the dynamic files simply rank above them). Needs systemd. Run with sudo:
#   sudo <plugin folder>/hooks/resource-guard/setup-swap.sh
# macOS and Windows already have dynamic, compressed swap: nothing to do there.
set -euo pipefail
[ "$(uname -s)" = Linux ] || { echo "setup-swap: Linux only; macOS and Windows manage swap by themselves" >&2; exit 0; }
command -v systemctl >/dev/null || { echo "setup-swap: needs systemd" >&2; exit 1; }
[ "$(id -u)" = 0 ] || exec sudo -- "$0" "$@"

echo "== 1/5 install the zram generator and swapspace"
if command -v apt-get >/dev/null; then
  apt-get install -y systemd-zram-generator swapspace
elif command -v dnf >/dev/null; then
  dnf install -y zram-generator swapspace
elif command -v pacman >/dev/null; then
  pacman -S --needed --noconfirm zram-generator swapspace
else
  echo "setup-swap: no apt-get, dnf or pacman here; install zram-generator and swapspace by hand" >&2
  exit 1
fi

echo "== 2/5 zram: half of RAM, zstd, used before disk swap"
mkdir -p /etc/systemd
cat > /etc/systemd/zram-generator.conf <<'EOF'
[zram0]
zram-size = ram / 2
compression-algorithm = zstd
swap-priority = 100
EOF
# With zram the kernel should swap early and in single pages.
cat > /etc/sysctl.d/99-zram.conf <<'EOF'
vm.swappiness = 100
vm.page-cluster = 0
EOF
sysctl -q --system
systemctl daemon-reload
systemctl restart systemd-zram-setup@zram0.service

echo "== 3/5 swapspace: files under /var/lib/swapspace, 1-16 GB each, made and removed on demand"
cat > /etc/swapspace.conf <<'EOF'
swappath="/var/lib/swapspace"
min_swapsize="1g"
max_swapsize="16g"
lower_freelimit=20
upper_freelimit=60
freetarget=30
cooldown=60
EOF
systemctl enable --now swapspace.service

echo "== 4/5 retire fixed swap files from /etc/fstab (pages move to zram first)"
while read -r src _ type _; do
  case "$src" in ''|'#'*) continue ;; esac
  [ "$type" = swap ] && [ -f "$src" ] || continue
  if swapon --show=NAME --noheadings | grep -qx "$src"; then swapoff "$src"; fi
  sed -i "\|^$src[[:space:]]|d" /etc/fstab
  rm -f "$src"
  echo "removed $src"
done < /etc/fstab

echo "== 5/5 result"
swapon --show
zramctl
free -h
