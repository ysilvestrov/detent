import { describe, expect, it } from 'vitest';
import { chooseExecutor, withoutHost } from './executors.mjs';

const endpoint = (over) => ({
  provider_name: 'Other',
  tag: 'other',
  quantization: 'fp8',
  uptime_last_30m: 100,
  supported_parameters: ['max_tokens', 'structured_outputs'],
  pricing: { prompt: '0.000001', completion: '0.000002' },
  ...over,
});

describe('chooseExecutor', () => {
  it('takes the model own host with structured outputs, though it costs more', () => {
    const own = endpoint({ provider_name: 'Alibaba', tag: 'alibaba', quantization: 'unknown', pricing: { prompt: '0.000003', completion: '0.000009' } });
    const cheap = endpoint({ provider_name: 'Cheap', tag: 'cheap', pricing: { prompt: '0.0000001', completion: '0.0000002' } });
    expect(chooseExecutor('alibaba', [cheap, own])).toEqual({ tag: 'alibaba', price: { input: 3, output: 9 } });
  });

  it('takes the cheapest host with structured outputs when the own host has none', () => {
    const own = endpoint({ provider_name: 'DeepSeek', tag: 'deepseek', supported_parameters: ['max_tokens'] });
    const dear = endpoint({ tag: 'dear', pricing: { prompt: '0.000004', completion: '0.000008' } });
    const cheap = endpoint({ tag: 'cheap', pricing: { prompt: '0.0000015', completion: '0.0000025' } });
    expect(chooseExecutor('deepseek', [own, dear, cheap])).toEqual({ tag: 'cheap', price: { input: 1.5, output: 2.5 } });
  });

  it('writes the cache prices of the route when the host has them', () => {
    const own = endpoint({
      provider_name: 'Alibaba',
      tag: 'alibaba',
      pricing: { prompt: '0.00000015', completion: '0.00000047', input_cache_read: '0.000000016', input_cache_write: '0.0000002' },
    });
    expect(chooseExecutor('alibaba', [own])).toEqual({ tag: 'alibaba', price: { input: 0.15, output: 0.47, cachedInput: 0.016, cacheWrite: 0.2 } });
  });

  it('writes no cacheWrite for a host whose write price is zero', () => {
    const own = endpoint({
      provider_name: 'Alibaba',
      tag: 'alibaba',
      pricing: { prompt: '0.00000015', completion: '0.00000047', input_cache_read: '0.000000016', input_cache_write: '0' },
    });
    expect(chooseExecutor('alibaba', [own])).toEqual({ tag: 'alibaba', price: { input: 0.15, output: 0.47, cachedInput: 0.016 } });
  });

  it('writes no cacheWrite for a host whose write price is below the input', () => {
    const own = endpoint({
      provider_name: 'Google',
      tag: 'google-vertex/global',
      pricing: { prompt: '0.00000075', completion: '0.00000375', input_cache_read: '0.000000075', input_cache_write: '0.0000000416666666666667' },
    });
    expect(chooseExecutor('google', [own])).toEqual({ tag: 'google-vertex/global', price: { input: 0.75, output: 3.75, cachedInput: 0.075 } });
  });

  it('writes no cacheWrite for a host whose write price equals the input', () => {
    const own = endpoint({
      provider_name: 'Alibaba',
      tag: 'alibaba',
      pricing: { prompt: '0.0000002', completion: '0.0000004', input_cache_write: '0.0000002' },
    });
    expect(chooseExecutor('alibaba', [own])).toEqual({ tag: 'alibaba', price: { input: 0.2, output: 0.4 } });
  });

  it('skips a service tier of the own host, though it is cheaper', () => {
    const flex = endpoint({ provider_name: 'Google', tag: 'google-vertex/global/flex', quantization: 'unknown', pricing: { prompt: '0.000000375', completion: '0.000001875' } });
    const plain = endpoint({ provider_name: 'Google', tag: 'google-vertex/global', quantization: 'unknown', pricing: { prompt: '0.00000075', completion: '0.00000375' } });
    expect(chooseExecutor('google', [flex, plain])).toEqual({ tag: 'google-vertex/global', price: { input: 0.75, output: 3.75 } });
  });

  it.each(['deepinfra/fp8/flex', 'fireworks/spot', 'deepinfra/fp8/priority', 'relace/fast'])('skips the tier %s among other hosts', (tag) => {
    const tier = endpoint({ tag, pricing: { prompt: '0.0000001', completion: '0.0000001' } });
    const plain = endpoint({ tag: 'morph/fp8', pricing: { prompt: '0.000001', completion: '0.000002' } });
    expect(chooseExecutor('nobody', [tier, plain])).toEqual({ tag: 'morph/fp8', price: { input: 1, output: 2 } });
  });

  it('returns null when only a service tier fits', () => {
    expect(chooseExecutor('nobody', [endpoint({ tag: 'deepinfra/fp8/flex' })])).toBe(null);
  });

  it('rejects a quantization below fp8 and an uptime below 100', () => {
    const fp4 = endpoint({ tag: 'fp4', quantization: 'fp4', pricing: { prompt: '0.0000001', completion: '0.0000001' } });
    const flaky = endpoint({ tag: 'flaky', uptime_last_30m: 99, pricing: { prompt: '0.0000001', completion: '0.0000001' } });
    const fp16 = endpoint({ tag: 'fp16', quantization: 'fp16', pricing: { prompt: '0.000005', completion: '0.000005' } });
    expect(chooseExecutor('nobody', [fp4, flaky, fp16])).toEqual({ tag: 'fp16', price: { input: 5, output: 5 } });
  });

  it('rejects a host whose quantization is unknown when it is not the own host', () => {
    expect(chooseExecutor('nobody', [endpoint({ quantization: 'unknown' })])).toBe(null);
  });

  it('returns null when nobody fits', () => {
    expect(chooseExecutor('nobody', [endpoint({ supported_parameters: ['max_tokens'] }), endpoint({ uptime_last_30m: 80 })])).toBe(null);
  });
});

describe('withoutHost', () => {
  const alibaba = endpoint({ provider_name: 'Alibaba Cloud', tag: 'alibaba/fp8' });
  const other = endpoint({ provider_name: 'Other', tag: 'other' });

  it('removes a host named by its whole tag', () => {
    expect(withoutHost([alibaba, other], 'alibaba/fp8')).toEqual([other]);
  });

  it('removes every tag of a host named by the start of the tag', () => {
    expect(withoutHost([alibaba, endpoint({ tag: 'alibaba/fp16' }), other], 'alibaba')).toEqual([other]);
  });

  it('removes a host named by its provider name', () => {
    expect(withoutHost([alibaba, other], 'Alibaba Cloud')).toEqual([other]);
  });

  it('leaves the list alone when no host is named', () => {
    expect(withoutHost([alibaba, other], undefined)).toEqual([alibaba, other]);
  });
});
