# The big AI PR review test: report

English translation of [`report.md`](report.md). If the two disagree, the Ukrainian original is right.

Finished 2026-11-05. Spec: `docs/specs/2026-11/2026-11-03-pr-review-big-test-design.md`. Records are in `records/`, scores in `scores/`, grading decisions in `grading-notes.md`. Tables for every pair come from:

```bash
node scripts/eval/summary.mjs --batch-from 1 --cache-rule on
```

Everything was measured on one project, warsaw-beer-bot, on two PRs for missed defects and four corpus PRs. These numbers prove nothing about other projects.

## Profiles

Owner's decision of 2026-11-05. The default pair does not change.

| Provider | Profile | Pair | #418, published of 5 | #930, published of 3 | Corpus: published, `false` | First review of #418 |
|---|---|---|---|---|---|---|
| `openai` | best, default | `gpt-5.6-sol` + `gpt-5.5` | 3, 5, 4, median 4 | 2, 3, 2, median 2 | 17, 0 | $0.47 |
| `openai` | balanced, best value | `gpt-6.1-terra` + `gpt-6.1-terra` | 4, 4, 4, median 4 | 1, 1, 1, median 1 | 17, 0 | $0.09 |
| `anthropic` | all three | `claude-sonnet-5-5` + `claude-sonnet-5-5` | 4, 3, 4, median 4 | 1, 1, 1, median 1 | 6, 0 | $0.25–0.26 |
| `openrouter` | empty | | | | | |

Prices at list, with cache writes off where the code turns them off.

## What the table does not show

- **`gpt-6.1-terra` + `gpt-6.1-terra`.** `summary.mjs` says "loses no named defect", but that is the union of three runs. In each single run on #418 the pair loses one defect (D5 twice, D1 once), and it never finds R2 or R3 on #930. Its 5/5/5 in the "per draw" column belongs to the find stage of the selection batches, not to this run.
- **`gpt-6.1-terra` + `gpt-5.5`.** Median 5 on #418, but 1 against 2 on #930. Under the spec's rule, a lead not confirmed on #930 is a tie, and the baseline pair stays. Without the baseline pair's R2 on #930 this row would have needed another look, so the owner checked those findings first and agreed.
- **`claude-sonnet-5-5`.** Passes the admission as written, but published 6 findings on the corpus against 17, and none on #352 and #356, although the find stage raised one on each. The owner left the rule unchanged. `summary.mjs` shows a price of $0.22–0.23 with the find stage of batch 3, and its "unstable" flag also comes from batches 3–4; the real runs of batch 106 cost $0.25–0.26. The `anthropic` row in `summary.mjs` (sonnet + terra) cannot run through one provider, so by the owner's decision sonnet + sonnet was taken.
- **Empty judge responses.** `summary.mjs` shows 2 for `gpt-6.1-terra` + `gpt-5.5`. Under the amendment of 2026-11-04 they do not count against the limit, because they happened under the old judge limit.

## Judges

Agreement with the consensus on `verify-corpus`, 15 records, 3 runs: `gpt-5.5` 15, `gpt-6.1-sol` 15, `gpt-6.1-terra` 15, `claude-sonnet-5-5` 14, `claude-haiku-5-5` 11 (fails).

The judge sees a group of findings from one file, so it answers `out_of_scope` on real defects that span files. That is how every judge lost D1 on the baseline pair's finding, and Sonnet also lost D5 and D1 on its own. Swapping the judge on the same findings of batch 104: `gpt-6.1-terra` differed in 1 verdict of 23, Sonnet lost D2 twice and D1 once.

## Default prompts

Batch 105: 4, 3, 4 on #418, 16 published on the corpus, 15 `real`, 1 `unfalsifiable`, 0 `false`. D2 reached the judge 1 of 3 times against 3 of 3 with the project's own prompts. The prompts differ only by the project name, some of the scope wording and `{{reviewContext}}`, so this says little about other projects.

## Second try

The owner's hypothesis held: the models spend the limit on reasoning. There is no common fix. Find stage only, on #418, all preliminary: no model went through the judge, #930 or the corpus.

| Model | Setting | Defects | Does not find | Find cost |
|---|---|---|---|---|
| `mimo-v2.6-pro` | limit 32,000 | 3, 4, 4 | D2 | ≈$0.04, output up to 31,009 tokens, almost at the limit |
| `kimi-k3.1-pro` | limit 8000, reasoning low | 3, 4, 4 | D5 | ≈$0.08–0.15 |
| `hy4-preview` | limit 32,000 | 3, 1, empty | out | |
| `glm-5.3-flashx-legal` | reasoning low | 1 | out | |
| `gemini-3.8-flash` | limit 32,000 / low | D4 / empty list | out | |
| `step-5-preview` | limit 32,000 | 0 with 12 findings | out | |
| `qwen3.8-flash`, `qwen3.8-max-0902`, `deepseek-v4.1-flash-1017` | both | empty | out | |

For comparison, the same find stage: `gpt-6.1-terra` 5, 5, 5 for $0.07, `gpt-5.6-sol` 4, 5, 4 for $0.31. The owner stopped the test without filling the `openrouter` table. `gemini-3.8-flash` with an empty list and a normal finish reads as a clean review; the README warns about this.

## Cache

A write costs 25% more than input. Only an identical request reads it.

| Case | Read | Written | Reads per token |
|---|---|---|---|
| #688, next head (`records/cache-688.jsonl`) | 0 | 23,585 | 0 |
| #688, repeat of an identical request, batch 0 | 18,646 | 18,646 | 1.00 |
| Judge, whole test | 0 | 247,683 | 0 |

The overall 1.38 in `summary.mjs` comes from repeats of one head during measurements. Taken literally, the 0.28 threshold "on `--base` and on repeats" does not trigger, so turning writes off is the owner's decision. It was checked live on `gpt-5.6-sol` (batch 0), `gpt-6.1-terra` and `gpt-6.1-sol` (`records/cache-off-895.jsonl`): no write, no 400. `gpt-6-astra` keeps writing, because it was not checked.

## Spend

Ledger $27.48 of the $30 ceiling: OpenAI $15.07, Anthropic $6.04, OpenRouter $4.61, manual $1.75 (`verify-corpus` $1.52, cache $0.23).

Reconciled with the provider dashboards on 2026-11-04. OpenRouter matched. Anthropic matched with a lag. OpenAI matched exactly on requests (384) and tokens (2,776,159), but billed $8.67 against ≈$14.03 at list. Billed tokens are 27–79% of used ones, differently per model, which looks like free daily tokens for data sharing, but the usage page does not say so, so it is not proven. The category lines sum to $9.17, not $8.67, for an unknown reason. The ledger overstates, so the ceiling is safe, and the README keeps list prices. The `verify-corpus` script's own $0.6442 for `gpt-5.5` is understated: the dashboard shows no cached tokens from it, and at list it is ≈$0.90.

## Owner check

2026-11-05: 66 counted findings of the four deciding pairs and 10 random ones of 239 others, seed `6664aa1`. 76 agreed, 0 disagreed, scores unchanged. The owner did not look at corpus findings outside the sample. Which finding closes which defect was matched by the report's author, not blind; only the scores themselves stay blind.

## Not checked

- The spend line on a real push after publication against the dashboard: that is the acceptance of PR 2 under the spec.
- Anthropic price rows with cache: the request does not ask for caching, and the records have no read field.
- Turning writes off on Azure or another route: direct OpenAI only.
