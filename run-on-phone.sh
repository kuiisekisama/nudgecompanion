#!/data/data/com.termux/files/usr/bin/sh
# Starts Nudge on this phone. Open http://localhost:8000 in Chrome afterwards.
cd "$(dirname "$0")" || exit 1
command -v python >/dev/null 2>&1 || pkg install -y python
echo "Nudge is running. In Chrome open:  http://localhost:8000"
echo "Leave this window open (or swipe Termux notification: Acquire wakelock)."
python -m http.server 8000 --bind 127.0.0.1
