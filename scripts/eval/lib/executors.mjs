// Which OpenRouter host serves a model in the big test: the rule of the spec, applied to a `/endpoints` response.
const QUANTIZATIONS = ['fp8', 'fp16', 'bf16', 'fp32'];
const PER_MILLION = 1e6;

const normalize = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
const hasSchema = (endpoint) => (endpoint.supported_parameters ?? []).includes('structured_outputs');
const perMillion = (perToken) => Number((Number(perToken) * PER_MILLION).toPrecision(10));

function priceOf(endpoint) {
  const { prompt, completion, input_cache_read: read, input_cache_write: write } = endpoint.pricing;
  return {
    input: perMillion(prompt),
    output: perMillion(completion),
    ...(read === undefined ? {} : { cachedInput: perMillion(read) }),
    ...(write === undefined ? {} : { cacheWrite: perMillion(write) }),
  };
}

const cost = (endpoint) => perMillion(endpoint.pricing.prompt) + perMillion(endpoint.pricing.completion);
const cheapest = (endpoints) => endpoints.reduce((best, e) => (best === null || cost(e) < cost(best) ? e : best), null);

/**
 * The model's own host if it has `structured_outputs`; otherwise the cheapest host with them, quantized fp8 or better,
 * with 100 uptime over the last 30 minutes. `{tag, price}` (price per million tokens), or null when nobody fits.
 */
export function chooseExecutor(modelVendor, endpoints) {
  const withSchema = endpoints.filter(hasSchema);
  const chosen =
    cheapest(withSchema.filter((e) => normalize(e.provider_name) === normalize(modelVendor))) ??
    cheapest(withSchema.filter((e) => QUANTIZATIONS.includes(e.quantization) && e.uptime_last_30m === 100));
  return chosen === null ? null : { tag: chosen.tag, price: priceOf(chosen) };
}
