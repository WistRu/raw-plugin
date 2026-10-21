#!/bin/sh
# The team folder's lock under a real race: N processes take the same
# flock the way hooks/team/folder.ts does (descriptor 9 on the file,
# `flock 9`, then the holder's own process keeps it), each holds it a
# moment and appends "start <n>" and "end <n>" to one log. With a correct
# lock every "start" is followed by its own "end" before the next "start",
# and a holder killed while holding releases it. The plugin test kit runs
# no processes, so this is a shell test: `sh hooks/team/lock.test.sh [n]`.
set -u
dir=$(mktemp -d)
log="$dir/log"
lock="$dir/.flock"
n=${1:-12}
: > "$log"
i=1
while [ "$i" -le "$n" ]; do
  sh -c 'exec 9>"$3"; flock -w 10 9 || exit 1; echo "start $1" >> "$2"; sleep 0.05; echo "end $1" >> "$2"' sh "$i" "$log" "$lock" &
  i=$((i + 1))
done
wait
# every odd line a start, every even line the matching end
bad=0
lines=$(wc -l < "$log")
k=1
while [ "$k" -lt "$lines" ]; do
  s=$(sed -n "${k}p" "$log")
  e=$(sed -n "$((k + 1))p" "$log")
  case "$s" in start\ *) ;; *) bad=1 ;; esac
  [ "end ${s#start }" = "$e" ] || bad=1
  k=$((k + 2))
done
[ "$lines" -eq $((n * 2)) ] || bad=1
# a dead holder releases: the holder is one process (sh that became sleep)
sh -c 'exec 9>"$1"; flock 9 || exit 1; exec sleep 1000' sh "$lock" &
holder=$!
sleep 0.3
if flock -w 1 "$lock" true; then bad=1; heldwhilealive=no; else heldwhilealive=yes; fi
kill "$holder" 2>/dev/null
sleep 0.3
if flock -w 2 "$lock" true; then released=yes; else released=no; bad=1; fi
rm -rf "$dir"
if [ "$bad" -eq 0 ]; then
  echo "lock race test: PASS ($n holders, $lines lines, no overlap; held while the holder lived: $heldwhilealive; released after its kill: $released)"
  exit 0
fi
echo "lock race test: FAIL ($n holders, $lines lines; held while alive: $heldwhilealive; released after kill: $released)"
exit 1
