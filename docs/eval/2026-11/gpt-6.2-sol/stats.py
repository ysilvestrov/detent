import json,os,collections
D=os.path.join(os.path.dirname(os.path.abspath(__file__)),"records")
P={'gpt-5.5':(5,.5,5,30),'gpt-5.6-sol':(4,.4,5,20),'gpt-5.6-sol@dec':(5,.5,6.25,30),'gpt-6.2-sol':(2,.1,2.5,10)}
def norm(m):
  for k in ('gpt-5.5','gpt-5.6-sol','gpt-6.2-sol'):
    if m.startswith(k): return k
def cost(m,u,dec=False):
  k=norm(m); k=k+'@dec' if dec and k=='gpt-5.6-sol' else k; i,c,w,o=P[k]
  pt=u.get('prompt_tokens',0); d=u.get('prompt_tokens_details') or {}; ca=d.get('cached_tokens',0); wr=d.get('cache_write_tokens',0)
  return (max(0,pt-ca-wr)*i+ca*c+wr*w+u.get('completion_tokens',0)*o)/1e6
rows=collections.defaultdict(dict)
for lab in ('base','cand','vj62','vj55'):
  calls=collections.defaultdict(list); runs=[]
  for l in open(f'{D}/{lab}.jsonl'):
    o=json.loads(l)
    if o['type']=='call': calls[o['runId']].append(o)
    elif o['type']=='run': runs.append(o)
  for r in runs:
    cs=calls[r['runId']]
    f=[c for c in cs if c['stage']=='find']; v=[c for c in cs if c['stage']=='verify']
    pub=sum(1 for x in (r.get('results') or []) if x.get('verdict')=='confirmed')
    rows[(lab,r['pr'],r['draw'])]=dict(raised=r['raised'],gated=r['gated'],pub=pub,
      fin=sum(c['usage'].get('prompt_tokens',0) for c in f),fout=sum(c['usage'].get('completion_tokens',0) for c in f),
      freas=sum((c['usage'].get('completion_tokens_details') or {}).get('reasoning_tokens',0) for c in f),
      vcalls=len(v),vin=sum(c['usage'].get('prompt_tokens',0) for c in v),vout=sum(c['usage'].get('completion_tokens',0) for c in v),
      fusd=sum(cost(c['model'],c['usage']) for c in f),vusd=sum(cost(c['model'],c['usage']) for c in v),
      fusd_dec=sum(cost(c['model'],c['usage'],True) for c in f),
      fin_finish=[c.get('finishReason') for c in cs if c.get('finishReason')!='stop'],
      cached=sum((c['usage'].get('prompt_tokens_details') or {}).get('cached_tokens',0) for c in cs),
      writes=sum((c['usage'].get('prompt_tokens_details') or {}).get('cache_write_tokens',0) for c in cs))
for k in sorted(rows): print(k, {a:(round(b,4) if isinstance(b,float) else b) for a,b in rows[k].items()})
