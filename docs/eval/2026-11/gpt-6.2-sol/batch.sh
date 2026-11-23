#!/usr/bin/env bash
set -uo pipefail
R="${HOME:?}/projects/warsaw-beer-bot/tmp/eval-62sol/run.sh"
F="${HOME:?}/projects/warsaw-beer-bot/tmp/eval-62sol/findings"
step() { "$R" "$@"; rc=$?; [ $rc -eq 3 ] && { echo "STOPPED at ceiling"; exit 3; }; return 0; }
# baseline, full runs
for d in 1 2 3; do step base $d full 418 584aa661 gpt-5.6-sol gpt-5.5; step base $d full 930 a5926a74 gpt-5.6-sol gpt-5.5; done
step base 1 full 344 ef2ebd21c4e4051c405641ab54763cb2bedc8c33 gpt-5.6-sol gpt-5.5
step base 1 full 352 afd96de5a0ce180c38493a692311f36fd479a914 gpt-5.6-sol gpt-5.5
step base 1 full 356 e3157536e3830a54ffdd5ef6f7a4b2f1923d1907 gpt-5.6-sol gpt-5.5
step base 1 full 358 6f1bd706e364d9070566e2d7e2cca142b665706a gpt-5.6-sol gpt-5.5
# candidate find, saved
for d in 2 3; do step cand $d find 418 584aa661 gpt-6.2-sol gpt-6.2-sol; done
for d in 1 2 3; do step cand $d find 930 a5926a74 gpt-6.2-sol gpt-6.2-sol; done
step cand 1 find 344 ef2ebd21c4e4051c405641ab54763cb2bedc8c33 gpt-6.2-sol gpt-6.2-sol
step cand 1 find 352 afd96de5a0ce180c38493a692311f36fd479a914 gpt-6.2-sol gpt-6.2-sol
step cand 1 find 356 e3157536e3830a54ffdd5ef6f7a4b2f1923d1907 gpt-6.2-sol gpt-6.2-sol
step cand 1 find 358 6f1bd706e364d9070566e2d7e2cca142b665706a gpt-6.2-sol gpt-6.2-sol
# judges on identical saved findings: cheap judge first so the ceiling cuts the dear one
for f in "$F"/cand-*.json; do b=$(basename "$f" .json); pr=$(echo "$b" | cut -d- -f2); d=$(echo "$b" | cut -d- -f3)
  step vj62 "$d" verify "$pr" "$f" gpt-6.2-sol gpt-6.2-sol; done
for f in "$F"/cand-*.json; do b=$(basename "$f" .json); pr=$(echo "$b" | cut -d- -f2); d=$(echo "$b" | cut -d- -f3)
  step vj55 "$d" verify "$pr" "$f" gpt-6.2-sol gpt-5.5; done
echo BATCH DONE
