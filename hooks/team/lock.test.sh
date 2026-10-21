#!/bin/sh
# The team folder's lock under a real race, with the holder script taken
# from hooks/team/folder.ts itself (HOLD_SH): N holders at once, each
# waits for its `held`, appends "start <n>" and "end <n>" to one log and is
# killed; with a correct lock every "start" is followed by its own "end"
# before the next "start". Then: a holder killed releases, and a holder
# whose PARENT is killed -9 (the session's process crashing) releases on
# its own within a few seconds. The plugin test kit runs no processes, so
# this is a shell test: `sh hooks/team/lock.test.sh [n]`.
set -u
here=$(cd "$(dirname "$0")" && pwd)
hold=$(sed -n 's/^const HOLD_SH = `\(.*\)`$/\1/p' "$here/folder.ts")
[ -n "$hold" ] || { echo "lock race test: FAIL (HOLD_SH not found in folder.ts)"; exit 1; }
dir=$(mktemp -d)
log="$dir/log"
lock="$dir/.flock"
n=${1:-12}
: > "$log"
i=1
while [ "$i" -le "$n" ]; do
  (
    out="$dir/out.$i"
    sh -c "$hold" hold "$lock" 10 > "$out" &
    h=$!
    while ! grep -q held "$out" 2>/dev/null; do
      kill -0 "$h" 2>/dev/null || { echo "worker $i: holder gone, out=[$(cat "$out" 2>/dev/null)]" >> "$dir/diag"; exit 1; }
      sleep 0.02
    done
    echo "start $i" >> "$log"
    sleep 0.05
    echo "end $i" >> "$log"
    kill "$h" 2>/dev/null
    wait "$h" 2>/dev/null
  ) &
  i=$((i + 1))
done
wait
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

# a killed holder releases
sh -c "$hold" hold "$lock" 10 > "$dir/out.k" &
holder=$!
while ! grep -q held "$dir/out.k" 2>/dev/null; do sleep 0.02; done
if flock -w 1 "$lock" true; then bad=1; heldalive=no; else heldalive=yes; fi
kill "$holder" 2>/dev/null
wait "$holder" 2>/dev/null
if flock -w 3 "$lock" true; then released=yes; else released=no; bad=1; fi

# a holder whose parent dies -9 (the session crashing) releases by itself
sh -c 'sh -c "$1" hold "$2" 10 > "$3" & wait' outer "$hold" "$lock" "$dir/out.p" &
parent=$!
while ! grep -q held "$dir/out.p" 2>/dev/null; do sleep 0.02; done
kill -9 "$parent" 2>/dev/null
wait "$parent" 2>/dev/null
if flock -w 4 "$lock" true; then orphan=released; else orphan=STUCK; bad=1; fi
pkill -f "hold $lock" 2>/dev/null
[ -f "$dir/diag" ] && cat "$dir/diag"; rm -rf "$dir"
if [ "$bad" -eq 0 ]; then
  echo "lock race test: PASS ($n holders, $lines lines, no overlap; held while alive: $heldalive; released after kill: $released; after the parent's kill -9: $orphan)"
  exit 0
fi
echo "lock race test: FAIL ($n holders, $lines lines; held while alive: $heldalive; released after kill: $released; after the parent's kill -9: $orphan)"
exit 1
