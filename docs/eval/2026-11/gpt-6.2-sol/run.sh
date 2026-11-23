#!/usr/bin/env bash
# One replay under the spend ceiling. Usage:
#   run.sh <label> <draw> <mode: full|find|verify> <pr> <head-or-findings-file> <find-model> <verify-model>
set -euo pipefail
EVAL="${HOME:?}/projects/warsaw-beer-bot/tmp/eval-62sol"
REPO="${HOME:?}/projects/warsaw-beer-bot"
CEILING=10
MARGIN=0.75   # the dearest single run (baseline full #930) measured ≈$0.49; refuse to start one that could cross
label="${1:?}"; draw="${2:?}"; mode="${3:?}"; pr="${4:?}"; arg="${5:?}"; fm="${6:?}"; vm="${7:?}"
mkdir -p "$EVAL/records" "$EVAL/findings" "$EVAL/logs"
spent=$(node "$EVAL/spend.mjs" "$EVAL/records" | cut -d' ' -f1)
if awk -v s="$spent" -v m="$MARGIN" -v c="$CEILING" 'BEGIN{exit !(s+m>c)}'; then
  echo "CEILING: spent \$$spent, next run could cross \$$CEILING — stopping" >&2; exit 3
fi
set -a; . "${HOME:?}/.config/detent/keys.env"; set +a
export AI_REVIEW_MODEL="$fm" AI_REVIEW_VERIFY_MODEL="$vm"
export AI_REVIEW_CACHE=off AI_REVIEW_CACHE_OFF_MODELS="gpt-5.6-sol,gpt-6.1-terra,gpt-6.1-sol,gpt-6.2-sol"
export AI_REVIEW_RECORD_META="{\"label\":\"$label\",\"draw\":$draw,\"mode\":\"$mode\"}"
rec="$EVAL/records/$label.jsonl"
log="$EVAL/logs/$label-$mode-$pr-$draw.log"
cd "$REPO"
case "$mode" in
  full)   args=(pr-review --replay "$pr" --head "$arg" --provider openai --record "$rec") ;;
  find)   args=(pr-review --replay "$pr" --head "$arg" --provider openai --record "$rec" --find-only --save-findings "$EVAL/findings/$label-$pr-$draw.json") ;;
  verify) args=(pr-review --replay "$pr" --provider openai --record "$rec" --verify-from "$arg") ;;
  *) echo "bad mode $mode" >&2; exit 2 ;;
esac
set +e
node node_modules/@ysilvestrov/detent/dist/cli.js "${args[@]}" >"$log" 2>&1
rc=$?
set -e
echo "[$label $mode #$pr d$draw] exit $rc; spent now \$$(node "$EVAL/spend.mjs" "$EVAL/records")"
grep -E "Context budget|finish|error|Error" "$log" | head -5 || true
exit $rc
