#!/usr/bin/env bash
# Anonymization and secret gate. Scans what would enter git for personal data:
# LAN/WAN addresses, machine hostnames, personal home paths, personal emails,
# credential shapes. This script itself is safe to publish: it contains only
# generic pattern classes and allow-list fixtures. The owner-specific deny list
# (real machine names, private remote host, personal drive labels) lives
# OUTSIDE this repository by design; restore it from the owner's encrypted
# backup — it is deliberately not recoverable from git.
#
# Usage:
#   scripts/anonymization_gate.sh tree              # scan tracked + untracked working files
#   scripts/anonymization_gate.sh staged            # scan staged additions
#   scripts/anonymization_gate.sh range <from>..<to>
#   scripts/anonymization_gate.sh pre-push          # git pre-push hook (reads stdin)
# Install as a hook (hooks are not versioned; re-run after any re-clone):
#   install -m 0755 scripts/anonymization_gate.sh .git/hooks/pre-push

set -u
LC_ALL=C; export LC_ALL

DENYLIST="${DEAS_DENYLIST_FILE:-$HOME/.config/deas/anonymization-denylist.txt}"

# Each entry: <label>|<PCRE>
CLASSES=(
  'LAN/WAN IPv4|\b(192\.168|172\.(1[6-9]|2[0-9]|3[01])|10\.[0-9]{1,3})\.[0-9]{1,3}\.[0-9]{1,3}\b'
  'local domain|.b[a-z0-9][a-z0-9-]*\.lan\b'
  'allcaps hostnames|\b[A-Z]{3,}(MACHINE|HOST|NAS|BOX)\b'
  'personal home path|/home/(?!u\b|user\b|dev\b|test\b|tester\b|runner\b|ci\b|example\b|action\b|agent\b)[a-z][a-z0-9_-]{1,}'
  'windows user dir|[A-Za-z]:\\Users\\(?!testacct\b|user\b|dev\b|runner\b|example\b|admin\b|Public\b)[A-Za-z0-9._-]+'
  'personal email|[A-Za-z0-9._%+-]+@(gmail|outlook|hotmail|yahoo|proton(mail)?|gmx|web|t-online|freenet|icloud|live|me)\.(com|de|net|at|ch|io|app)([."'"'"' ,)\]]|$)'
  'token shapes|\b(hf_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{16,})\b'
  'private key header|-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'inline credential|[Aa]pi[_-]?[Kk]ey["'"'"']?\s*[:=]\s*["'"'"'][A-Za-z0-9._-]{16,}["'"'"']'
)

scan_text() {
  local label="$1" entry label2 re hits local_found=0
  for entry in "${CLASSES[@]}"; do
    [[ -z "$entry" ]] && continue
    label2="${entry%%|*}"; re="${entry#*|}"
    hits="$(grep -nP -- "$re" 2>/dev/null || true)"
    if [[ -n "$hits" ]]; then
      local_found=1
      printf '== [%s] %s ==\n' "$label" "$label2"
      sed 's/^/   /' <<<"$hits"
    fi
  done
  if [[ -f "$DENYLIST" ]]; then
    hits="$(grep -nFf -- "$DENYLIST" 2>/dev/null || true)"
    if [[ -n "$hits" ]]; then
      local_found=1
      printf '== [%s] private denylist hit ==\n' "$label"
      sed 's/^/   /' <<<"$hits"
    fi
  else
    echo "note: denylist $DENYLIST not found; generic checks only (restore the denylist from your private backup, never from git)"
  fi
  return "$local_found"
}

mode="${1:-staged}"
case "$mode" in
  tree)
    allow_filter=()
    if [[ -f scripts/anonymization_gate.allow ]]; then
      while IFS= read -r a; do [[ -n "$a" && "${a:0:1}" != "#" ]] && allow_filter+=("^$a\$"); done < scripts/anonymization_gate.allow
    fi
    files="$(git ls-files --cached --others --exclude-standard |
      grep -vE '^(node_modules/|dist/|\.target/|src-tauri/(target|forge-data)/|artifacts/|output/)')"
    if (( ${#allow_filter[@]} )); then
      files="$(echo "$files" | grep -vE "$(IFS='|'; echo "${allow_filter[*]}")" || true)"
    fi
    echo "$files" | xargs -r grep -In --binary-files=without-match . | scan_text "tree" || { echo "BLOCKED: anonymization gate found personal data."; exit 1; }
    ;;
  staged)
    git diff --cached -U0 | grep -E '^\+[^+]' | sed 's/^+//' | scan_text "staged diff" || { echo "BLOCKED: anonymization gate found personal data in staged diff."; exit 1; }
    ;;
  range)
    rng="${2:?usage: range <from>..<to>}"
    git diff -U0 "$rng" | grep -E '^\+[^+]' | sed 's/^+//' | scan_text "range $rng" || { echo "BLOCKED: anonymization gate found personal data in $rng."; exit 1; }
    ;;
  pre-push)
    while read -r lref lsha rref rsha; do
      [[ "$lsha" =~ ^0+$ ]] && continue
      if [[ "$rsha" =~ ^0+$ ]]; then
        git log -p --no-color "$lsha" --not --remotes
      else
        git diff -U0 "$rsha".."$lsha"
      fi | grep -E '^\+[^+]' | sed 's/^+//' | scan_text "push $rref" || { echo "BLOCKED: anonymization gate found personal data in $rref."; exit 1; }
    done
    ;;
  *)
    echo "usage: $0 [tree|staged|range <a>..<b>|pre-push]"; exit 2
    ;;
esac

echo "anonymization gate: clean"
exit 0
