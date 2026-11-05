#!/bin/sh
set -eu
# Change only existing loopback local routes; IPv6 may be disabled entirely.
while :; do
  for family in -4 -6; do
    ip -o "$family" route show table local type local dev lo | while IFS= read -r route; do
      case "$route" in
        'local 127.0.0.0/8 '*|'local 127.0.0.1 '*|'local 127.0.0.1/32 '*|'local ::1 '*)
          case " $route " in *' quickack 1 '*) continue ;; esac
          route=$(printf '%s\n' "$route" | sed -E 's/ quickack [0-9]+//g')
          # Linux normalizes IPv6 metric 0 to 1024 on change, so the kernel's
          # generated ::1 route cannot be changed in place. Install its tuned
          # replacement first, then remove the metric-0 route without a gap.
          case "$family $route" in
            '-6 local ::1 '*' metric 0 '*)
              ip -6 route replace local ::1 dev lo table local proto kernel metric 1 quickack 1
              ip -6 route del local ::1 dev lo table local proto kernel metric 0
              continue
              ;;
          esac
          # dev lo is omitted by ip show when it was used as a filter.
          # The route output is a whitespace-separated argument list, not code.
          ip "$family" route change table local $route dev lo quickack 1
          ;;
      esac
    done
  done
  sleep 30
done
