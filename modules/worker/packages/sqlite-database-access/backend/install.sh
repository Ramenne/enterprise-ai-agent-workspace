#!/bin/bash
# Install worker/config only; no member qualification or database row mutation.
set -euo pipefail
[ "$(id -u)" = 0 ]
base=$(cd "$(dirname "$0")" && pwd)
install -d -m 0755 /srv/workspace
install -d -m 0700 -o baize -g baize /srv/workspace
install -m 0644 "$base/sqlite_worker.py" "$base/sqlite_runner.py" /srv/workspace
# Private root configuration is deliberately excluded from engineering source.
if [ -f "$base/sqlite-targets.json" ]; then
  install -m 0600 "$base/sqlite-targets.json" /etc/workspace-hub2/runtime/sqlite-targets.json
else
  test -r /etc/workspace-hub2/runtime/sqlite-targets.json
fi
# Existing root loopback runtime relay dispatch must import sqlite_runner.execute
# only for action database_sqlite after its existing relay authentication.
