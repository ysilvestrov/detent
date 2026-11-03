// Loaded with `node --import` by funnel.test.mjs: `fetch` answers `/endpoints` from the JSON file named by STUB_ENDPOINTS,
// `{model: {status, endpoints}}` or `{model: {status, body}}` for a body of another shape, and writes each model it was
// asked for into STUB_ENDPOINTS_LOG. No network.
import { appendFileSync, readFileSync } from 'node:fs';

const answers = JSON.parse(readFileSync(process.env.STUB_ENDPOINTS, 'utf8'));

globalThis.fetch = async (url) => {
  const model = /models\/(.+)\/endpoints/.exec(String(url))[1];
  appendFileSync(process.env.STUB_ENDPOINTS_LOG, `${model}\n`);
  const { status, endpoints, body = { data: { endpoints } } } = answers[model];
  return new Response(JSON.stringify(body), { status });
};
