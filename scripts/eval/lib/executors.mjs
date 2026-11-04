// Which OpenRouter host serves a model in the big test: the rule of the spec, applied to a `/endpoints` response.
const QUANTIZATIONS = ['fp8', 'fp16', 'bf16', 'fp32'];
const PER_MILLION = 1e6;
/** A tag ending so names a service tier of a host, with its own price and behaviour, not the host a reader gets by default. */
const TIER_TAG = /\/(flex|spot|priority|fast)$/;

const normalize = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
const hasSchema = (endpoint) => (endpoint.supported_parameters ?? []).includes('structured_outputs') && !TIER_TAG.test(endpoint.tag);
const perMillion = (perToken) => Number((Number(perToken) * PER_MILLION).toPrecision(10));

function priceOf(endpoint) {
  const { prompt, completion, input_cache_read: read, input_cache_write: write } = endpoint.pricing;
  return {
    input: perMillion(prompt),
    output: perMillion(completion),
    ...(read === undefined ? {} : { cachedInput: perMillion(read) }),
    // Only a write price above the input is a write tariff. Zero would price a first run's input at nothing, and
    // Google's far smaller figure would price it at a fraction: `productionUsd` bills the whole input at `cacheWrite`.
    ...(Number(write) > Number(prompt) ? { cacheWrite: perMillion(write) } : {}),
  };
}

const cost = (endpoint) => perMillion(endpoint.pricing.prompt) + perMillion(endpoint.pricing.completion);
const cheapest = (endpoints) => endpoints.reduce((best, e) => (best === null || cost(e) < cost(best) ? e : best), null);

/** The endpoints without a host, named by its tag, the start of its tag or its provider name; `undefined` removes nobody. */
export function withoutHost(endpoints, host) {
  if (host === undefined) return endpoints;
  const name = normalize(host);
  return endpoints.filter((e) => ![e.tag, String(e.tag).split('/')[0], e.provider_name].some((known) => normalize(known) === name));
}

/**
 * The model's own host if it has `structured_outputs`; otherwise the cheapest host with them, quantized fp8 or better,
 * with 100 uptime over the last 30 minutes. A service tier is not a host for either. `{tag, price}` (price per million
 * tokens), or null when nobody fits.
 */
export function chooseExecutor(modelVendor, endpoints) {
  const withSchema = endpoints.filter(hasSchema);
  const chosen =
    cheapest(withSchema.filter((e) => normalize(e.provider_name) === normalize(modelVendor))) ??
    cheapest(withSchema.filter((e) => QUANTIZATIONS.includes(e.quantization) && e.uptime_last_30m === 100));
  return chosen === null ? null : { tag: chosen.tag, price: priceOf(chosen) };
}
