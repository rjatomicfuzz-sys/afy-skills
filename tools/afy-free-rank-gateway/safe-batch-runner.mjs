import fs from 'node:fs';
import path from 'node:path';
import { runBatch } from './batch-runner.mjs';

const MIN_COUNTY_START_INTERVAL_MS = 8000;
const STATE_CODES = Object.freeze({
  Alabama:'AL', Alaska:'AK', Arizona:'AZ', Arkansas:'AR', California:'CA', Colorado:'CO', Connecticut:'CT', Delaware:'DE', Florida:'FL', Georgia:'GA', Hawaii:'HI', Idaho:'ID', Illinois:'IL', Indiana:'IN', Iowa:'IA', Kansas:'KS', Kentucky:'KY', Louisiana:'LA', Maine:'ME', Maryland:'MD', Massachusetts:'MA', Michigan:'MI', Minnesota:'MN', Mississippi:'MS', Missouri:'MO', Montana:'MT', Nebraska:'NE', Nevada:'NV', 'New Hampshire':'NH', 'New Jersey':'NJ', 'New Mexico':'NM', 'New York':'NY', 'North Carolina':'NC', 'North Dakota':'ND', Ohio:'OH', Oklahoma:'OK', Oregon:'OR', Pennsylvania:'PA', 'Rhode Island':'RI', 'South Carolina':'SC', 'South Dakota':'SD', Tennessee:'TN', Texas:'TX', Utah:'UT', Vermont:'VT', Virginia:'VA', Washington:'WA', 'West Virginia':'WV', Wisconsin:'WI', Wyoming:'WY', 'District of Columbia':'DC'
});

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, v) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); }

function installGatewayPacer() {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  let chain = Promise.resolve();
  let nextAllowedAt = 0;

  globalThis.fetch = function pacedFetch(input, init) {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (!String(url).includes('/api/identity-pro')) return nativeFetch(input, init);

    const task = chain.then(async () => {
      const waitMs = Math.max(0, nextAllowedAt - Date.now());
      if (waitMs) await sleep(waitMs);
      nextAllowedAt = Date.now() + MIN_COUNTY_START_INTERVAL_MS;
      return nativeFetch(input, init);
    });
    chain = task.then(() => undefined, () => undefined);
    return task;
  };
}

function stateCountyPostFilter(requestPath) {
  const request = readJson(requestPath);
  const outputPath = path.resolve(process.cwd(), request.outputFile || 'tools/afy-free-rank-gateway/output/latest.json');
  const summaryPath = path.resolve(process.cwd(), request.summaryFile || 'tools/afy-free-rank-gateway/output/summary.json');
  const output = readJson(outputPath);

  const kept = [];
  const excluded = [];
  for (const c of Array.isArray(output.candidates) ? output.candidates : []) {
    const expected = STATE_CODES[c.state];
    const actual = String(c.stateCode || '').toUpperCase();
    if (expected && actual === expected) kept.push(c);
    else excluded.push({ ...c, exclusionReason: `STATE_MISMATCH:${actual || 'MISSING'}!=${expected || 'UNKNOWN_EXPECTED'}` });
  }

  output.preStateGuardCandidateCount = (output.candidates || []).length;
  output.stateGuardExcluded = excluded;
  output.candidates = kept;
  output.outsideCountyNoise = [...(output.outsideCountyNoise || []), ...excluded];
  output.productionSafety = {
    countyStartIntervalMs: MIN_COUNTY_START_INTERVAL_MS,
    textSearchProjectQuotaPerMinuteObserved: 30,
    stateAndCountyGuard: true,
    enterpriseAllowed: false
  };
  writeJson(outputPath, output);

  const summary = fs.existsSync(summaryPath) ? readJson(summaryPath) : {};
  summary.preStateGuardCandidates = output.preStateGuardCandidateCount;
  summary.stateGuardExcluded = excluded.length;
  summary.candidates = kept.length;
  summary.outsideCountyNoise = output.outsideCountyNoise.length;
  summary.productionSafety = output.productionSafety;
  writeJson(summaryPath, summary);
  return { kept: kept.length, excluded: excluded.length };
}

const requestPath = path.resolve(process.cwd(), process.argv[2] || 'tools/afy-free-rank-gateway/batch-run-request.json');
installGatewayPacer();

runBatch(requestPath)
  .then(() => {
    const result = stateCountyPostFilter(requestPath);
    console.log(JSON.stringify({ productionSafetyApplied: true, ...result }, null, 2));
  })
  .catch(error => {
    try { stateCountyPostFilter(requestPath); } catch (filterError) { console.error(filterError?.stack || filterError); }
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
