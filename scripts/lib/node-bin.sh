# Picks the node binary the launcher should embed.
#
# `ensure_node` keeps the system node when it is new enough, so $CARLS_NODE_DIR
# is only populated after a tarball install. Embedding "$CARLS_NODE_DIR/bin/node"
# unconditionally produces a launcher that cannot start on a machine that already
# had a good node. Keep this in its own file so it can be tested in isolation.
carls_resolve_node_bin() {
  if [ -n "${CARLS_NODE_DIR:-}" ] && [ -x "$CARLS_NODE_DIR/bin/node" ]; then
    printf '%s\n' "$CARLS_NODE_DIR/bin/node"
    return 0
  fi
  resolved="$(command -v node 2>/dev/null || true)"
  if [ -n "$resolved" ]; then
    printf '%s\n' "$resolved"
    return 0
  fi
  printf '%s\n' "/usr/bin/env node"
}
