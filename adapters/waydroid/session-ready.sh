#!/usr/bin/env bash
# Wait until the Waydroid session is fully booted, then make it usable headless:
# disable auto-suspend, unfreeze the LXC container, and (re)grant the mic
# permission GME needs to transmit. Used as ExecStartPost of
# waydroid-session.service; safe to run by hand any time.
set -euo pipefail

pkg=com.gmebot.test
lxc=(-P /var/lib/waydroid/lxc -n waydroid)
shell() { sudo -n waydroid shell -- "$@"; }

for _ in $(seq 1 90); do
  if waydroid status 2>/dev/null | grep -q 'Session:.*RUNNING' \
     && [[ "$(shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; then
    break
  fi
  sleep 2
done
[[ "$(shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]] \
  || { echo "Waydroid did not finish booting" >&2; exit 1; }

waydroid prop set persist.waydroid.suspend false
if sudo -n lxc-info "${lxc[@]}" -sH | grep -q FROZEN; then
  sudo -n lxc-unfreeze "${lxc[@]}"
fi
shell pm grant "$pkg" android.permission.RECORD_AUDIO || echo "warning: could not grant RECORD_AUDIO to $pkg" >&2
echo "Waydroid ready"
