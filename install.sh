#!/bin/bash
# AWS Context Pack — Install Script
# Installs as a Claude Code plugin from the current directory

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "AWS Context Pack — Claude Code Plugin"
echo "======================================"
echo ""
echo "Installing from: $SCRIPT_DIR"
echo ""

# Build manifest if not already built
if [ ! -f "$SCRIPT_DIR/generated/skill-manifest.json" ]; then
  echo "Building skill manifest..."
  node "$SCRIPT_DIR/scripts/build-manifest.mjs"
fi

# Validate skills
echo "Validating skills..."
node "$SCRIPT_DIR/scripts/validate.mjs"

echo ""
echo "Installation complete. Add to Claude Code with:"
echo ""
echo "  claude plugin add \"$SCRIPT_DIR\""
echo ""
echo "Or add to .claude/settings.json manually:"
echo ""
echo "  {\"plugins\": [\"$SCRIPT_DIR\"]}"
echo ""
