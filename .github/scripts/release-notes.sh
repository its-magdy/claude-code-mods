#!/usr/bin/env bash
# Prints the release notes for a mod's current version: its CHANGELOG entry
# followed by the install command. Fails when the entry is missing or empty.
#
#   .github/scripts/release-notes.sh <mod>
set -euo pipefail

mod="$1"
version="$(node -p 'require(process.argv[1]).version' "$PWD/$mod/.claude-plugin/plugin.json")"

# The lines between "## <version>" (alone or followed by a space) and the next
# "## " heading, without blank lines at either end.
entry="$(awk -v v="$version" '
  /^## / {
    if (found) exit
    rest = substr($0, 4)
    found = rest == v || index(rest, v " ") == 1
    next
  }
  found
' "$mod/CHANGELOG.md" | sed -e '/./,$!d' | sed -e ':a' -e '/^\n*$/{$d;N;ba' -e '}')"

if [ -z "$entry" ]; then
  echo "::error file=$mod/CHANGELOG.md::No entry for $mod $version; add a \"## $version\" section" >&2
  exit 1
fi

cat <<NOTES
$entry

## Install

\`\`\`
/plugin install $mod --marketplace $GITHUB_REPOSITORY
\`\`\`
NOTES
