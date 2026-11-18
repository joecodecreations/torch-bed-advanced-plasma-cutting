#!/bin/zsh
# Double-click to start the plasma jog controller and open its page.
cd "$(dirname "$0")"
(sleep 1.5 && open "http://127.0.0.1:8790") &
exec python3 server.py "$@"
