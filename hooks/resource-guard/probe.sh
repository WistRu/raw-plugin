#!/bin/sh

# Prints one JSON line with the machine's resources. Linux, macOS and Windows
# (under Git Bash / MSYS, where uname says MINGW or MSYS).
# Fields: os cores mem_total mem_avail swap_total swap_free load1 cpu heavy_jobs
# systemd swap_dynamic tmp top (memory in bytes; load1 = 1-minute load average;
# cpu = busy cores right now, from two samples 0.2 s apart; heavy_jobs = scopes
# running in the slice named as $1, if any; systemd = 1 when a systemd user
# manager answers, so the mod can make a memory slice and run heavy commands
# inside it; swap_dynamic = 1 when swap grows by itself: zram plus swapspace
# on Linux, always on macOS and Windows; tmp = a folder for the mod's run
# files, made here; top = the three processes using the most memory).
set -u

slice_name="${1:-}"
os=$(uname -s)
case "$os" in MINGW*|MSYS*|CYGWIN*) os=Windows ;; esac
cores=1; mem_total=0; mem_avail=0; swap_total=0; swap_free=0; load1=0; cpu=0; heavy_jobs=0; systemd=0; swap_dynamic=0; top=""
tmp="${TMPDIR:-/tmp}/raw-plugin"
mkdir -p "$tmp" 2>/dev/null || tmp=""

# Busy cores from two /proc/stat samples (Linux).
cpu_busy_linux() {
  read -r _ u1 n1 s1 i1 w1 q1 sq1 _ < /proc/stat
  sleep 0.2
  read -r _ u2 n2 s2 i2 w2 q2 sq2 _ < /proc/stat
  awk -v c="$cores" -v b=$(( (u2+n2+s2+q2+sq2) - (u1+n1+s1+q1+sq1) )) -v t=$(( (u2+n2+s2+i2+w2+q2+sq2) - (u1+n1+s1+i1+w1+q1+sq1) )) \
    'BEGIN { if (t > 0) printf "%.2f", b / t * c; else print 0 }'
}

if [ "$os" = "Linux" ]; then
  cores=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN)
  # /proc/meminfo reports kB.
  eval "$(awk '
    $1=="MemTotal:"     {printf "mem_total=%d;",  $2*1024}
    $1=="MemAvailable:" {printf "mem_avail=%d;",  $2*1024}
    $1=="SwapTotal:"    {printf "swap_total=%d;", $2*1024}
    $1=="SwapFree:"     {printf "swap_free=%d;",  $2*1024}
  ' /proc/meminfo)"
  load1=$(cut -d' ' -f1 /proc/loadavg)
  cpu=$(cpu_busy_linux)
  top=$(ps -eo rss=,comm= --sort=-rss 2>/dev/null | head -3 | awk '{printf "%s%s %.1fG", (NR>1?", ":""), $2, $1/1048576}' | tr -cd 'A-Za-z0-9 .,_:-')
  if command -v systemd-run >/dev/null 2>&1 && systemctl --user show -p Version >/dev/null 2>&1; then
    systemd=1
    if [ -n "$slice_name" ]; then
      cg=$(systemctl --user show -p ControlGroup --value "$slice_name" 2>/dev/null)
      [ -n "$cg" ] && [ -d "/sys/fs/cgroup$cg" ] &&
        heavy_jobs=$(find "/sys/fs/cgroup$cg" -maxdepth 1 -name '*.scope' 2>/dev/null | wc -l | tr -d ' ')
    fi
    grep -q '^/dev/zram' /proc/swaps 2>/dev/null && [ "$(systemctl is-active swapspace.service 2>/dev/null)" = active ] && swap_dynamic=1
  fi
elif [ "$os" = "Windows" ]; then
  swap_dynamic=1  # the page file grows by itself and memory is compressed, as on macOS
  # One PowerShell call: free/total RAM and page file in KB, CPU %, logical cores.
  eval "$(powershell.exe -NoProfile -NonInteractive -Command '
    $os = Get-CimInstance Win32_OperatingSystem
    $load = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
    $cores = (Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
    $pft = (Get-CimInstance Win32_PageFileUsage | Measure-Object -Property AllocatedBaseSize -Sum).Sum
    $pfu = (Get-CimInstance Win32_PageFileUsage | Measure-Object -Property CurrentUsage -Sum).Sum
    "cores=$cores; mem_total=$($os.TotalVisibleMemorySize*1024); mem_avail=$($os.FreePhysicalMemory*1024); swap_total=$($pft*1048576); swap_free=$(($pft-$pfu)*1048576); load1=$([math]::Round($load/100*$cores,2)); cpu=$([math]::Round($load/100*$cores,2));"
  ' 2>/dev/null | tr -d '\r')"
elif [ "$os" = "Darwin" ]; then
  swap_dynamic=1  # macOS makes and removes swap files by itself and compresses memory
  cores=$(sysctl -n hw.ncpu)
  mem_total=$(sysctl -n hw.memsize)
  page=$(sysctl -n hw.pagesize)
  # free + inactive + speculative pages count as available, as Activity Monitor does.
  mem_avail=$(vm_stat | awk -v p="$page" '
    /Pages free/        {f=$3} /Pages inactive/ {i=$3} /Pages speculative/ {s=$3}
    END {gsub(/\./,"",f); gsub(/\./,"",i); gsub(/\./,"",s); printf "%d", (f+i+s)*p}')
  # "total = 2048.00M  used = 1200.00M  free = 848.00M"
  eval "$(sysctl -n vm.swapusage | awk '{
    gsub(/M/,"",$3); gsub(/M/,"",$9);
    printf "swap_total=%d; swap_free=%d;", $3*1048576, $9*1048576}')"
  load1=$(sysctl -n vm.loadavg | awk '{print $2}')
  cpu=$(ps -A -o %cpu= 2>/dev/null | awk '{s+=$1} END {printf "%.2f", s/100}')
  top=$(ps -axm -o rss=,comm= 2>/dev/null | head -3 | awk '{n=$2; sub(/.*\//,"",n); printf "%s%s %.1fG", (NR>1?", ":""), n, $1/1048576}' | tr -cd 'A-Za-z0-9 .,_:-')
fi

printf '{"os":"%s","cores":%s,"mem_total":%s,"mem_avail":%s,"swap_total":%s,"swap_free":%s,"load1":%s,"cpu":%s,"heavy_jobs":%s,"systemd":%s,"swap_dynamic":%s,"tmp":"%s","top":"%s"}\n' \
  "$os" "$cores" "$mem_total" "$mem_avail" "$swap_total" "$swap_free" "$load1" "$cpu" "$heavy_jobs" "$systemd" "$swap_dynamic" "$tmp" "$top"
