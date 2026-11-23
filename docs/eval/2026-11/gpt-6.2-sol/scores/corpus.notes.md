# Corpus grading notes (blind)

PR heads were fetched (`git fetch origin pull/<n>/head`) and every finding was checked with `git show <head>:<file>`. Diff bases: merge-base with origin/main (#344 8092ad25, #352 c182a8b9, #356 = parent of e3157536, #358 15c26852). Labels follow `docs/ai-review-model-evaluation.md` §1. For consistency with the 2026-07 baseline (`2026-07-28-ai-review-baseline-labels.md`), a design trade-off that the PR's own design doc or code comment records is labelled `unfalsifiable` ("design preference restated as a defect").

No finding was labelled `false`: every claim's stated mechanism matches the code at its head. The disagreements are about whether the mechanism matters, and those go to `unfalsifiable`.

## Shared finding labels

Several ids repeat the same finding. Each is labelled once here and referenced by its tag below.

### PR #358 (head 6f1bd706)

- **T1** `src/jobs/orphan-triage.ts:175`, probes and verification each get the full `probeLimit`: **real**. The comment at :21 and spec.md say "shared budget"/"Бюджет спільний з верифікацією", but `collectTriageProbes` and `verifyCauses` each count `spent` from 0 against the same limit, so the total can reach 2×limit.
- **T2** `orphan-triage.ts:173`, `TRIAGE_PROBE_LIMIT=0` still runs the gate: **real**. The comment at :22-23 and `.env.example` say 0 makes the job behave as before. But index.ts always passes `search`, the gate is guarded only by `if (deps.search)`, and `verifyCauses` with limit 0 returns false for every causal verdict, so every attachment is stripped.
- **T3** `src/index.ts:286/311`, the triage cron does not consult the Algolia breaker: **real**. Both calls pass the raw `algoliaSearch` and no breaker, while refresh/enrich get `breaker: algoliaBreaker`. spec.md says an open breaker should only remove evidence.
- **T4** `index.ts:311`, triage ignores `UNTAPPD_LOOKUP_ENABLED`: **real**. Every other Algolia consumer (refresh-ontap, enrich-orphans, refresh-tap-ratings) is gated by `lookupEnabled`. Triage gets an unconditional search dep, so the kill switch does not stop its searches.
- **T5** `orphan-triage.ts:185`, duplicate verdicts share one verification entry: **real**. `verifyCauses` does `out.set(beer_id, …)` per verdict, so the last one overwrites. The planner keeps the first verdict per beer (triage-plan.ts:75), so a failing first verdict can borrow a later success.
- **T6** `orphan-triage.ts:175`, verification budget spent on out-of-batch verdicts: **real**. `verifyCauses` receives the unfiltered `analysis.verdicts`, while batch filtering happens later in `planTriageActions`. Foreign causal verdicts increment `spent` and can starve in-batch ones.
- **T7** `orphan-triage.ts:189`, nulling refs turns a contradictory verdict into a quiet one: **unfalsifiable** (see below).
- **T8** `src/domain/triage-verify.ts:55`, the gate checks that the target exists, not that it is the orphan's beer: **unfalsifiable** (see below).
- **T9** `triage-verify.ts:55`, the gate does not compare against a baseline query: **unfalsifiable** (see below).
- **T10** `triage-verify.ts:26`, `expectedKey` splits at the first spaced dash, including one inside the brewery name: **real**. `/\s+[—–-]\s+/.exec` takes the first match, so `North - South — Pils` gives brewery `North` and name `South — Pils`, and `.has(expected)` fails for a correct hit. The em-dash the prompt asks for is not preferred.
- **T11** `src/domain/triage-analysis.ts:187`, the prompt treats a top-3 sample as the brewery's catalogue: **real**. `summarizeCandidates` slices to `MAX_SUMMARY_ITEMS = 3` (candidate-format.ts), yet the new prompt says "a brewery whose catalogue comes back but holds no such beer is not_on_untappd". A beer ranked 4th on the brewery query is therefore steered to `not_on_untappd`.
- **T12** `triage-analysis.ts:122`, the new `style` field bypasses the per-field cap: **real**. The diff adds `b.style` to `UntriagedFailure` (enrich_failures.ts). `boundOrphan` spreads `...o` and caps only brewery, name, URLs, summary and query, against the file's own rule at :101-103 ("Cap each text field before it reaches the prompt").
- **T13** `triage-verify.ts:47`, unbounded `proposed_query`: **unfalsifiable** (see below).
- **T14** `orphan-triage.ts:186`, `unverified` counts out-of-batch verdicts: **real**. The counter increments in the map over all verdicts before the planner's batch filter, and `outcome.unverified = unverified` goes straight into the digest line.
- **T15** `src/config/env.ts:38`, a blank `TRIAGE_PROBE_LIMIT=` silently gives 0: **real**. There is no empty-string preprocessing in `loadEnv`. `z.coerce.number()` turns `''` into 0, `.min(0)` accepts it, and `.default` fires only for undefined. Combined with T2, a blank value strips all attachments.

### PR #344 (head ef2ebd21)

- **P1** `scripts/pin-match.ts:37` (unpin) and `:58` (pin), `parseInt(beer,10)` accepts `12junk`/`33280x`: **real**. No full-string validation. On the pin path the truncated id can merge and delete a different row.
- **P2** `pin-match.ts:9-10`, `parseBid` accepts any string ending in digits: **real**. The comment says "full Untappd URL or bare numeric id", but `/(\d+)\/?$/` takes trailing digits from anything, so `-1` becomes 1.
- **P3** `pin-match.ts:10`, `…/6614460?ref=123` gives 123: **real**. The regex is anchored at the end of the whole input, so a URL with a query string yields the wrong bid, and the pin or merge goes to an unrelated beer.
- **P4** `pin-match.ts:58`, a `noop` (unknown beer) exits 0: **real**. Every other failure branch sets `process.exitCode = 1`. This one prints the JSON and exits successfully.
- **P5** `src/domain/pin-match.ts:25`, the merge path does not check that the source is an orphan: **real**. Only `canonical.id !== beerId` is checked, never `beer.untappd_id`. A wrong (or P1-truncated) id moves an identified beer's links and check-ins and deletes its row.
- **P6** `pin-match.ts:38`, the set path overwrites an existing `untappd_id`: **real**. The same missing guard: the SELECT reads `untappd_id`, then never uses it.
- **P7** `pin-match.ts:40`, `set` is returned even when zero links were pinned: **unfalsifiable** (see below).
- **P8** `src/jobs/refresh-ontap.ts:105`, the pin check and `upsertMatch` are not atomic: **unfalsifiable** (see below).
- **P9** `refresh-ontap.ts:105`, a pin keyed by `beer_ref` suppresses other breweries' taps with the same name: **unfalsifiable** (see below).
- **P10** `pin-match.ts:38`, re-pinning is not a strict no-op (timestamp, catalog bump): **unfalsifiable** (see below).
- **P11** `pin-match.ts:12`, `parseBid` accepts 0 and unsafe integers: **unfalsifiable** (see below).
- **P12** `pin-match.ts:18`, `argVal` takes the next flag as a value: **real**. With `--unpin --ref --beer 28831`, ref is `'--beer'` (truthy), the command unpins 0 links and exits 0, and the intended `--beer` branch never runs.

### PR #352 (head afd96de5)

- **W1** `src/domain/web-fallback.ts:157`, Brave failures appear as the `no-candidates` verdict: **unfalsifiable** (see below).
- **W2** `web-fallback.ts:174`, a throw from `stampWebTried` in `finally` skips the per-call log: **unfalsifiable** (see below).
- **W3** `src/storage/enrich_failures.ts:78`, the 0↔>0 reset can clear a `parser_bug` block: **unfalsifiable** (see below).
- **W4** `src/api/routes/enrich.ts:141`, a merged response returns the candidate's rating, not the canonical row's: **unfalsifiable** (see below).
- **W5** `src/domain/web-fallback.test.ts:257`, three new tests never close their db: **unfalsifiable** (see below).
- **W6** `web-fallback.test.ts:303`, `toBeTruthy()` on the row object, not on `web_tried_at`: **real**. `.get()` returns `{web_tried_at: null}`, which is truthy, so the test cannot catch a missing stamp. This is a weak assertion where an exact value is known.
- **W7** `enrich_failures.ts:74`, `parser_bug` keeps the paid fallback blocked after a parser fix while candidates stay 0: **unfalsifiable** (see below; graded under the same standard as its mirror W3).

### PR #356 (head e3157536)

- **N1** `src/domain/normalize.ts:222`, the length check after an ASCII-only fold drops `Øl`: **real**. `stripDiacritics` uses NFD plus explicit ł handling. `Ø` does not decompose, so it is removed by `[^a-z0-9]`, the fold becomes `l` (length 1) and the token is dropped. The raw name comes back only when `out` is empty (`out.length ? out.join(' ') : (cleanName || …)` at :236-237). Brewery `Pinta` survives, so the query really is `Pinta`. Before the diff the fold `l` was non-empty and kept, so this is a regression introduced by this diff.
- **N2** `normalize.ts:220`, punctuation-joined one-character parts (`Rock-n-Roll`, `Pork'N'Roll`) still reach Algolia: **unfalsifiable** (see below).

## Per id

Each line gives file:line, the label, and a short reason; the full reason is under the tag above.

**e38656f8976d** (#358), 11 real / 0 false / 4 unfalsifiable. **cfa259478a01** (#358) has the same 15 findings in the same order, 11 / 0 / 4:
1. orphan-triage.ts:175, real: T1, probes and verification get separate full budgets despite the documented shared one.
2. orphan-triage.ts:173, real: T2, limit 0 still strips every attachment.
3. index.ts:286, real: T3, the raw `algoliaSearch` is used with no breaker.
4. index.ts:311, real: T4, `UNTAPPD_LOOKUP_ENABLED` is not honoured.
5. orphan-triage.ts:185, real: T5, the map is keyed by beer_id, the last write wins and the planner keeps the first verdict.
6. orphan-triage.ts:175, real: T6, foreign verdicts consume the verification budget.
7. orphan-triage.ts:189, unfalsifiable: T7, policy preference that the spec already settles.
8. triage-verify.ts:55, unfalsifiable: T8, asks for a stronger gate than the documented one.
9. triage-verify.ts:55, unfalsifiable: T9, gate redesign.
10. triage-verify.ts:26, real: T10, the split at the first spaced dash breaks `North - South — Pils`.
11. triage-analysis.ts:187, real: T11, a top-3 sample is presented as the brewery's catalogue.
12. triage-analysis.ts:122, real: T12, the new `style` field is uncapped.
13. triage-verify.ts:47, unfalsifiable: T13, generic length validation.
14. orphan-triage.ts:186, real: T14, the digest counts out-of-batch verdicts.
15. env.ts:38, real: T15, a blank value coerces to 0.

**cfcf96254495** (#358), 6 / 0 / 0:
1. orphan-triage.ts:173, real: T2.
2. orphan-triage.ts:174, real: T1.
3. triage-verify.ts:45, real: T6, foreign verdicts spend the budget before the planner filters them (duplicates are part of the same mechanism).
4. orphan-triage.ts:182, real: T14.
5. triage-verify.ts:25, real: T10.
6. index.ts:284, real: T3.

**e601ab2b37cd** (#344), 3 / 0 / 0:
1. scripts/pin-match.ts:36, real: P1, `parseInt` truncates `12junk`.
2. scripts/pin-match.ts:9, real: P2, any trailing digits are accepted (`-1` becomes 1).
3. scripts/pin-match.ts:58, real: P4, `noop` exits 0.

**20059b8ec833** (#344), 6 / 0 / 5:
1. src/domain/pin-match.ts:25, real: P5, the merge path deletes a non-orphan source.
2. src/domain/pin-match.ts:38, real: P6, the set path overwrites an existing identity.
3. src/domain/pin-match.ts:40, unfalsifiable: P7, "set" is truthful and the zero-link scenario is assumed.
4. src/jobs/refresh-ontap.ts:105, unfalsifiable: P8, cross-process race in a millisecond window.
5. src/jobs/refresh-ontap.ts:105, unfalsifiable: P9, coarse keying recorded in the PR's design doc.
6. src/domain/pin-match.ts:38, unfalsifiable: P10, same end state with only the timestamp changed.
7. scripts/pin-match.ts:10, real: P3, `?ref=123` gives 123.
8. scripts/pin-match.ts:12, unfalsifiable: P11, unsafe integers and 0 are not realistic input.
9. scripts/pin-match.ts:58, real: P1, the pin path truncates `33280x`.
10. scripts/pin-match.ts:37, real: P1, the unpin path truncates `28831x`.
11. scripts/pin-match.ts:18, real: P12, `--ref --beer` sets ref to `'--beer'`.

**a5662dc8853d** (#344), 7 / 0 / 5: items 1-11 as in 20059b8ec833, plus:
12. scripts/pin-match.ts:58, real: P4, `noop` exits 0.

**3cfffb11e96d** (#352), 1 / 0 / 5:
1. web-fallback.ts:157, unfalsifiable: W1, failures are already logged at warn by the resolver.
2. web-fallback.ts:174, unfalsifiable: W2, assumes the stamp write throws.
3. enrich_failures.ts:78, unfalsifiable: W3, documented reset rule.
4. api/routes/enrich.ts:141, unfalsifiable: W4, deliberate YAGNI in the design.
5. web-fallback.test.ts:257, unfalsifiable: W5, hygiene with no failure.
6. web-fallback.test.ts:303, real: W6, `toBeTruthy` on the row object.

**c039bbc4f591** (#352), 1 / 0 / 4:
1. web-fallback.ts:174, unfalsifiable: W2.
2. enrich_failures.ts:78, unfalsifiable: W3.
3. api/routes/enrich.ts:141, unfalsifiable: W4.
4. web-fallback.test.ts:257, unfalsifiable: W5.
5. web-fallback.test.ts:303, real: W6.

**49e3f59a071a** (#352), 0 / 0 / 1:
1. enrich_failures.ts:74, unfalsifiable: W7, assumes the same-row parser-fix path that the tree does not show.

**ced9e9e352e4** (#356), 1 / 0 / 0:
1. normalize.ts:222, real: N1, `Øl` is dropped and the query becomes `Pinta`.

**440fc4697a06** (#356), 1 / 0 / 1:
1. normalize.ts:222, real: N1.
2. normalize.ts:220, unfalsifiable: N2, depends on Algolia's tokenization and is not changed by this diff.

**e6b17c3bd37f** (#356), 0 / 0 / 1:
1. normalize.ts:220, unfalsifiable: N2 (the `Pork'N'Roll`/`A-Team` variant).

**Totals:** 48 real / 0 false / 30 unfalsifiable over 78 published findings.

## Reasoning for every `unfalsifiable`

- **T7**: The code does what the finding says. If a verdict carries both refs and fails verification, both refs are nulled and the planner pushes it to `quiet` (triage-plan.ts:89) instead of skipping it as contradictory (:84). But the routing is what gets stripped, and spec.md says outright that an unverified actionable verdict still has its class recorded ("клас **усе одно записується**"). Whether a verdict whose stripped routing was contradictory should be skipped rather than classified is a policy preference. The finding names no wrong result that the spec forbids.
- **T8**: The gate's documented contract, in its comment, the design and spec.md, is "re-run proposed_query; publish only if expected_target comes back". The finding asks the gate to also prove that the target is the orphan's beer by ABV. That is a different, stronger gate, so this is a design preference restated as a defect. The ABV comparison is assigned to the model in the prompt.
- **T9**: The same reasoning as T8. Asking the gate to replay and compare a baseline query is a redesign of the gate, not a defect against its stated contract.
- **T13**: "Unbounded model text is sent to Algolia" is a generic validation ask. No input is shown that leads to a wrong result: a long query just returns no target, so the verdict is marked unverified, which is the safe outcome.
- **P7**: The `set` branch does assign `untappd_id` and clear the failure, so "set" is truthful about that. Zero links happens legitimately, for example for beers that have no ontap `match_links`. The failure path depends on an assumed "tap ref already reassigned" state, not on any input shown.
- **P8**: The finding is about a second process (the CLI). `getMatch` (:104) and `upsertMatch` (:112/123) are two adjacent better-sqlite3 statements with only synchronous CPU work between them (`normalizeOntapTapIdentity`, `matchPrepared`) and no await. For the race to fire, a human-run CLI pin has to commit inside that sub-millisecond-to-millisecond gap between the two statements. The missing transaction is real, but no realistic trigger is shown, so this is speculation about timing.
- **P9**: The code does skip any tap whose `beer_ref` has a pinned link, whatever its brewery. But `match_links` is keyed by `ontap_ref` = beer_ref alone (UNIQUE, pre-existing), so two breweries' "Urodzinowe" already share one link row before this PR. The PR's own design doc (Non-goals, curated-match-pins-design.md:46-53) records exactly this trade-off: "pinning only changes last-writer-wins + self-heal into frozen". Adding a brewery check to the guard would not fix it either: `upsertMatch` would overwrite the shared pinned row while leaving `reviewed_by_user = 1`. This is a documented design choice restated as a defect.
- **P10**: The end state is identical: same untappd_id and the reviewed flag kept, as the idempotency test asserts. Only the `untappd_lookup_at` timestamp and a cache-version bump differ. No wrong result follows.
- **P11**: Untappd bids are about 7 digits, so the unsafe-integer case (above 2^53) cannot arise from real input. `0` is not a silent coercion of something else. It is a generic range-validation ask with no realistic input.
- **W1**: The code comment at :161-164 says outright that the Brave resolver converts errors to `[]`. The resolver itself logs every non-200 (`'brave search returned non-200'`) and every exception (`'brave search failed'`) at warn (resolver.ts:129-136). Its own comment explains that the warn exists because "a systematically broken key looks exactly like nothing matched". So the miss-versus-dead-key question that the per-call line's comment raises (:179-182) is still answerable from logs, by pairing the call line with the resolver's warn line. The design's stated purpose for the verdict, sizing #349, splits "Brave returned nothing" from "gate rejected". Its verdict set is `matched|no-candidates|rejected`. Wanting provider failures folded into the verdict field is a logging-granularity preference, not a defect that yields a wrong result.
- **W7** (mirror of W3, same standard): the failure needs a parser fix that changes the query of the **same** `beer_id` while leaving candidates at 0. Beer rows are keyed on `normalized_brewery` + `normalized_name` (`upsertBeer`, beers.ts:35-39). A parser fix that changes the parsed name normally changes the normalized name, which creates a new beer row with no failure row, and that row is not blocked. Nothing in the tree shows the same-row path the finding depends on. Like W3, the finding disputes how far the guard's block reaches, and it rests on an assumed data flow that the tree does not show.
- **W2**: This requires `stampWebTried`, a single-row UPDATE, to throw SQLITE_BUSY or SQLITE_FULL. Even then the exception propagates to the caller, which logs it, so the spent call is not silent. It is a generic "what if the db write fails" with no concrete trigger.
- **W3**: The 0↔>0 reset is the documented behaviour of `recordEnrichFailure` (its header comment: "cleared to re-open the row for triage"). The finding's failure is the guard honouring that documented reopening. That is a policy disagreement, not code contradicting its contract.
- **W4**: The claim is true in code: `toSearchResult` (web-fallback.ts:91-99) sets `global_rating: null`. But the PR's design doc states this deliberately: "Deliberate YAGNI: `rating_global` comes from `outcome.result`, not from the canonical row… extension already handles null… refresh-tap-ratings backfills it". A documented design choice restated as a defect.
- **W5**: True as stated: the three tests at :248, :260 and :272 lack `db.close()` while their neighbours have it. But these are in-memory test databases released at worker exit. No test or production behaviour goes wrong, so this is hygiene with no failure path.
- **N2**: The claim is conditional on external Algolia tokenization ("if Algolia splits the hyphens/apostrophes"), which the tree cannot show. The behaviour is also unchanged by this diff: before it, such tokens were emitted unchanged too. The commit's live replay concerned the whitespace-separated `Pork ,n' Roll`. This is speculation about an external system.

## Reasoning for every `false`

None. Each claim's mechanism was confirmed in the tree at its head. Checks that could have refuted a claim but did not:
- T3: `algoliaSearch` is the raw `createAlgoliaSearch` (index.ts:91-100), and there is no circuit or breaker reference anywhere under `src/sources/untappd/` at that head.
- T15: `loadEnv` is a plain `Schema.parse` with no empty-string stripping.
- N1: `stripDiacritics` has no Ø mapping.
- P12: the ref branch runs before the beer branch.
- W5: the three tests do lack `close()`.
- W6: `.get()` returns the row object.
