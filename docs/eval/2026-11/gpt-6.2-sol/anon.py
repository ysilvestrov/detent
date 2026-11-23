#!/usr/bin/env python3
# Blind grading input: every scored run's confirmed findings under a random id; the key stays apart.
#   anon.py make <eval-dir>   -> <eval-dir>/grade/anon.json, <eval-dir>/key/key.json
#   anon.py apply <eval-dir> <scores.json> -> prints the de-anonymised table
import json, os, random, sys, uuid

def runs(evald):
    out = []
    for label in ('base', 'vj62', 'vj55'):
        p = os.path.join(evald, 'records', f'{label}.jsonl')
        if not os.path.exists(p):
            continue
        for line in open(p):
            line = line.strip()
            if not line:
                continue
            o = json.loads(line)
            if o.get('type') == 'run' and o.get('exit') == 0:
                out.append(o)
    return out

def make(evald):
    items, key = [], {}
    for o in runs(evald):
        rid = uuid.uuid4().hex[:12]
        conf = [{k: r.get(k) for k in ('file', 'line', 'severity', 'confidence', 'quote', 'claim', 'whyItBreaks', 'verdict', 'evidence')}
                for r in (o.get('results') or []) if r.get('verdict') == 'confirmed']
        items.append({'id': rid, 'pr': o['pr'], 'head': o['head'], 'stage': 'whole', 'findings': conf})
        key[rid] = {'label': o['label'], 'draw': o['draw'], 'pr': o['pr'], 'runId': o['runId']}
    random.shuffle(items)
    os.makedirs(os.path.join(evald, 'grade'), exist_ok=True)
    os.makedirs(os.path.join(evald, 'key'), exist_ok=True)
    json.dump(items, open(os.path.join(evald, 'grade', 'anon.json'), 'w'), indent=1, ensure_ascii=False)
    json.dump(key, open(os.path.join(evald, 'key', 'key.json'), 'w'), indent=1)
    print(f'{len(items)} items')

def apply(evald, scores_path):
    key = json.load(open(os.path.join(evald, 'key', 'key.json')))
    scores = json.load(open(scores_path))
    missing = set(key) - set(scores)
    if missing:
        sys.exit(f'missing scores for {len(missing)} ids')
    rows = sorted(((v['label'], v['pr'], v['draw'], scores[k]) for k, v in key.items()), key=lambda r: (r[0], r[1], r[2]))
    for r in rows:
        print(r[0], r[1], r[2], json.dumps(r[3]))

if __name__ == '__main__':
    {'make': lambda: make(sys.argv[2]), 'apply': lambda: apply(sys.argv[2], sys.argv[3])}[sys.argv[1]]()
