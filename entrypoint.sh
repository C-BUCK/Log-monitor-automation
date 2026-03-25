#!/bin/bash
# Fix ownership on mounted volumes (Railway mounts as root)
chown -R pipeline:pipeline /data

# Ensure global npm binaries are on PATH for the pipeline user
export PATH="/usr/local/bin:$PATH"

# Run the app as non-root user (gosu preserves environment)
exec gosu pipeline "$@"
