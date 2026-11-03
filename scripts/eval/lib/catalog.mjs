// The candidate catalog: who may be tried, on which route, at what price. Read by every later script of the harness.
const ROUTES = ['openai', 'anthropic', 'openrouter'];
const TIERS = ['cheap', 'mid', 'expensive'];

function fail(field) {
  throw new Error(`candidates.json: invalid or missing ${field}`);
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v !== '';
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function checkPrice(price, field) {
  if (!isObject(price)) fail(field);
  if (!isNumber(price.input)) fail(`${field}.input`);
  if (!isNumber(price.output)) fail(`${field}.output`);
  for (const optional of ['cachedInput', 'cacheWrite']) {
    if (price[optional] !== undefined && !isNumber(price[optional])) fail(`${field}.${optional}`);
  }
}

/** Parses and checks the catalog. An `Error` names the first field that is wrong. */
export function loadCatalog(text) {
  const c = JSON.parse(text);
  if (!isObject(c.baseline)) fail('baseline');
  for (const key of ['label', 'findModel', 'verifyModel']) if (!isText(c.baseline[key])) fail(`baseline.${key}`);
  if (!ROUTES.includes(c.baseline.route)) fail('baseline.route');

  if (!Array.isArray(c.candidates)) fail('candidates');
  c.candidates.forEach((cand, i) => {
    const at = `candidates[${i}]`;
    if (!isObject(cand)) fail(at);
    if (!isText(cand.label)) fail(`${at}.label`);
    if (!isText(cand.model)) fail(`${at}.model`);
    if (!ROUTES.includes(cand.route)) fail(`${at}.route`);
    if (cand.only !== null && !(Array.isArray(cand.only) && cand.only.every(isText))) fail(`${at}.only`);
    if (!TIERS.includes(cand.tier)) fail(`${at}.tier`);
    checkPrice(cand.price, `${at}.price`);
  });

  if (!isObject(c.prices)) fail('prices');
  for (const [model, price] of Object.entries(c.prices)) checkPrice(price, `prices.${model}`);

  if (!isObject(c.prs)) fail('prs');
  for (const [pr, size] of Object.entries(c.prs)) {
    if (!isObject(size)) fail(`prs.${pr}`);
    if (size.head !== null && !isText(size.head)) fail(`prs.${pr}.head`);
    if (!isNumber(size.input)) fail(`prs.${pr}.input`);
    if (!isNumber(size.output)) fail(`prs.${pr}.output`);
  }
  for (const key of ['corpus', 'recallPrs']) if (!Array.isArray(c[key]) || !c[key].every(isText)) fail(key);
  return c;
}

/**
 * The price of a model, or null. An exact id wins; otherwise the longest known id the model starts with,
 * because a response names the model with a date appended.
 */
export function priceOf(catalog, model) {
  const known = { ...catalog.prices };
  for (const cand of catalog.candidates) known[cand.model] = cand.price;
  if (Object.hasOwn(known, model)) return known[model];
  const ids = Object.keys(known)
    .filter((id) => model.startsWith(id))
    .sort((a, b) => b.length - a.length);
  return ids.length === 0 ? null : known[ids[0]];
}
