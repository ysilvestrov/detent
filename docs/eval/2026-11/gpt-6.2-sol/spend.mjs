// Total spend at list across every records/*.jsonl call line; cached and written tokens at their own rates.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
const P = {
  'gpt-5.5': { i: 5, c: 0.5, w: 5, o: 30 },
  'gpt-5.6-sol': { i: 4, c: 0.4, w: 5, o: 20 },
  'gpt-6.2-sol': { i: 2, c: 0.1, w: 2.5, o: 10 },
};
const norm = (m) => (m.startsWith('gpt-5.5') ? 'gpt-5.5' : m.startsWith('gpt-5.6-sol') ? 'gpt-5.6-sol' : m.startsWith('gpt-6.2-sol') ? 'gpt-6.2-sol' : m);
const dir = process.argv[2];
let total = 0, unknown = 0;
if (existsSync(dir)) for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
  for (const l of readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.type !== 'call' && o.type !== 'corpus-call') continue;
    const u = o.usage ?? {};
    const p = P[norm(o.model ?? '')];
    if (!p) { unknown++; continue; }
    const pt = u.prompt_tokens ?? 0, c = u.prompt_tokens_details?.cached_tokens ?? 0, w = u.prompt_tokens_details?.cache_write_tokens ?? 0;
    total += (Math.max(0, pt - c - w) * p.i + c * p.c + w * p.w + (u.completion_tokens ?? 0) * p.o) / 1e6;
  }
}
console.log(total.toFixed(4) + (unknown ? ` (+${unknown} unpriced calls)` : ''));
