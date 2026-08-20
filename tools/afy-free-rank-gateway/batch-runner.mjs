import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_ATTEMPTS = 2;
const MAX_PAGE_EVENTS_PER_ATTEMPT = 3;
const RESERVATION_PER_COUNTY = MAX_ATTEMPTS * MAX_PAGE_EVENTS_PER_ATTEMPT;

const PROHIBITED_FIELD_TOKENS = [
  'rating',
  'userRatingCount',
  'websiteUri',
  'nationalPhoneNumber',
  'internationalPhoneNumber',
  'regularOpeningHours',
  'currentOpeningHours',
  'reviews'
];

export function normalizeJurisdiction(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(county|parish|borough|census area|municipality|planning region)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function isElectricianType(place) {
  const types = Array.isArray(place?.types) ? place.types : [];
  return place?.primaryType === 'electrician' || types.includes('electrician');
}

export function validateGatewayPayload(data) {
  if (!data || data.ok !== true) throw new Error('GATEWAY_PAYLOAD_NOT_OK');
  if (data.sourceMode !== 'TEXT_SEARCH_PRO_IDENTITY') throw new Error(`UNEXPECTED_SOURCE_MODE:${data.sourceMode}`);
  if (data.billingSkuCeiling !== 'TEXT_SEARCH_PRO') throw new Error(`UNEXPECTED_SKU:${data.billingSkuCeiling}`);
  if (data.enterpriseFieldsRequested !== false) throw new Error('ENTERPRISE_FIELD_FLAG_TRUE');
  const mask = String(data.billingFieldMask || '');
  if (!mask.includes('places.id') || !mask.includes('nextPageToken')) throw new Error('EXPECTED_ID_OR_PAGINATION_FIELD_MISSING');
  for (const token of PROHIBITED_FIELD_TOKENS) {
    if (mask.includes(token)) throw new Error(`PROHIBITED_FIELD_IN_MASK:${token}`);
  }
  const pagesFetched = Number(data.pagesFetched);
  if (!Number.isInteger(pagesFetched) || pagesFetched < 1 || pagesFetched > 3) {
    throw new Error(`INVALID_PAGES_FETCHED:${data.pagesFetched}`);
  }
  if (!Array.isArray(data.places)) throw new Error('PLACES_NOT_ARRAY');
  return true;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchCounty(gatewayBase, county, { maxRetries = MAX_ATTEMPTS - 1 } = {}) {
  const q = `electrician in ${county.county} County, ${county.state}`;
  const url = `${gatewayBase.replace(/\/$/, '')}/api/identity-pro?q=${encodeURIComponent(q)}`;
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error(`NON_JSON_GATEWAY_RESPONSE:${response.status}`); }

      if (response.ok) {
        validateGatewayPayload(data);
        return { data, url, attempts: attempt + 1 };
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) {
        const error = new Error(`GATEWAY_HTTP_${response.status}`);
        error.status = response.status;
        error.body = data;
        error.attempts = attempt + 1;
        throw error;
      }
      lastError = new Error(`RETRYABLE_GATEWAY_HTTP_${response.status}`);
      lastError.status = response.status;
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      const retryable = status === 429 || status >= 500 || status === 0;
      if (!retryable || attempt === maxRetries) {
        error.attempts = attempt + 1;
        throw error;
      }
    }
    const backoffMs = Math.min(10000, 750 * (2 ** attempt)) + Math.floor(Math.random() * 250);
    await sleep(backoffMs);
  }
  throw lastError || new Error('UNKNOWN_FETCH_FAILURE');
}

export function classifyCountyResult(county, data, now = new Date().toISOString()) {
  const target = normalizeJurisdiction(county.county);
  const candidates = [];
  const sabHolds = [];
  const outsideCounty = [];
  const unresolvedVisible = [];
  const typeNoise = [];
  const inactive = [];

  for (const p of data.places) {
    const base = {
      countyIndex: Number(county.countyIndex),
      fips: String(county.fips || ''),
      state: county.state,
      sourceCounty: county.county,
      sourcePopulation: Number(county.population || 0),
      businessName: p.displayName || null,
      placeId: p.placeId,
      googleMapsUri: p.googleMapsUri || null,
      countyRank: Number(p.rank),
      countyResultCount: Number(data.returnedCount),
      liveAddress: p.formattedAddress || null,
      city: p.city || null,
      returnedCounty: p.county || null,
      stateCode: p.stateCode || null,
      businessStatus: p.businessStatus || null,
      pureServiceAreaBusiness: p.pureServiceAreaBusiness === true,
      primaryType: p.primaryType || null,
      types: Array.isArray(p.types) ? p.types : [],
      sourceMode: data.sourceMode,
      billingSkuCeiling: data.billingSkuCeiling,
      observedAt: now
    };

    if (p.businessStatus !== 'OPERATIONAL') {
      inactive.push(base);
      continue;
    }
    if (!isElectricianType(p)) {
      typeNoise.push(base);
      continue;
    }
    if (p.pureServiceAreaBusiness === true) {
      sabHolds.push(base);
      continue;
    }
    const returned = normalizeJurisdiction(p.county);
    if (!returned) {
      unresolvedVisible.push(base);
      continue;
    }
    if (returned !== target) {
      outsideCounty.push(base);
      continue;
    }
    candidates.push(base);
  }

  return { candidates, sabHolds, outsideCounty, unresolvedVisible, typeNoise, inactive };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

function resolveRepoPath(p) {
  return path.resolve(process.cwd(), p);
}

export async function runBatch(requestPath) {
  const request = readJson(resolveRepoPath(requestPath));
  const countyFileSpecs = Array.isArray(request.countyFiles) && request.countyFiles.length
    ? request.countyFiles
    : [request.countyFile];
  if (!countyFileSpecs[0]) throw new Error('COUNTY_FILE_REQUIRED');
  const outputFile = resolveRepoPath(request.outputFile || 'tools/afy-free-rank-gateway/output/latest.json');
  const summaryFile = resolveRepoPath(request.summaryFile || 'tools/afy-free-rank-gateway/output/summary.json');
  const gatewayBase = String(request.gatewayBase || 'https://afy-free-rank-gateway.vercel.app');
  const targetCandidates = Math.max(1, Number(request.targetCandidates || 700));
  const maxPageEvents = Math.max(3, Number(request.maxPageEvents || 900));
  const concurrency = Math.min(5, Math.max(1, Number(request.concurrency || 3)));
  const skipStates = new Set(Array.isArray(request.skipStates) ? request.skipStates : []);

  let counties = [];
  for (const countyFileSpec of countyFileSpecs) {
    const block = readJson(resolveRepoPath(countyFileSpec));
    if (!Array.isArray(block)) throw new Error(`COUNTY_FILE_NOT_ARRAY:${countyFileSpec}`);
    counties.push(...block);
  }
  const uniqueCountyKeys = new Set();
  counties = counties
    .filter(c => c && !skipStates.has(c.state))
    .filter(c => {
      const key = `${Number(c.countyIndex)}|${c.state}|${c.county}`;
      if (uniqueCountyKeys.has(key)) return false;
      uniqueCountyKeys.add(key);
      return true;
    })
    .sort((a, b) => Number(b.population || 0) - Number(a.population || 0) || Number(a.countyIndex) - Number(b.countyIndex));

  const state = {
    runId: request.runId || `AFY_BATCH_${new Date().toISOString()}`,
    startedAt: new Date().toISOString(),
    completedAt: null,
    gatewayBase,
    countyFiles: countyFileSpecs,
    costGuard: {
      expectedSourceMode: 'TEXT_SEARCH_PRO_IDENTITY',
      expectedSkuCeiling: 'TEXT_SEARCH_PRO',
      enterpriseAllowed: false,
      maxPageEvents,
      actualPageEvents: 0
    },
    targetCandidates,
    countiesInput: counties.length,
    countiesAttempted: 0,
    countiesSucceeded: 0,
    countiesFailed: 0,
    candidates: [],
    sabHolds: [],
    outsideCountyNoise: [],
    unresolvedVisible: [],
    typeNoise: [],
    inactive: [],
    errors: [],
    checkpoints: []
  };

  const candidateIds = new Set();
  const sabIds = new Set();
  let nextIndex = 0;
  let reservedPageEvents = 0;
  let stopReason = null;

  function appendUnique(targetArray, items, seenSet) {
    for (const item of items) {
      if (!item.placeId || seenSet.has(item.placeId)) continue;
      seenSet.add(item.placeId);
      targetArray.push(item);
    }
  }

  async function worker(workerId) {
    while (true) {
      let county;
      if (stopReason) return;
      if (state.candidates.length >= targetCandidates) {
        stopReason = 'TARGET_CANDIDATES_REACHED';
        return;
      }
      if (nextIndex >= counties.length) {
        stopReason = stopReason || 'COUNTY_INPUT_EXHAUSTED';
        return;
      }
      if (state.costGuard.actualPageEvents + reservedPageEvents + RESERVATION_PER_COUNTY > maxPageEvents) {
        stopReason = stopReason || 'PRO_PAGE_EVENT_CAP_REACHED';
        return;
      }
      county = counties[nextIndex++];
      reservedPageEvents += RESERVATION_PER_COUNTY;
      state.countiesAttempted++;

      try {
        const { data, attempts } = await fetchCounty(gatewayBase, county);
        reservedPageEvents -= RESERVATION_PER_COUNTY;
        const chargedPageEvents = Number(data.pagesFetched) + Math.max(0, attempts - 1) * MAX_PAGE_EVENTS_PER_ATTEMPT;
        state.costGuard.actualPageEvents += chargedPageEvents;
        state.countiesSucceeded++;

        const classified = classifyCountyResult(county, data);
        appendUnique(state.candidates, classified.candidates, candidateIds);
        appendUnique(state.sabHolds, classified.sabHolds, sabIds);
        state.outsideCountyNoise.push(...classified.outsideCounty);
        state.unresolvedVisible.push(...classified.unresolvedVisible);
        state.typeNoise.push(...classified.typeNoise);
        state.inactive.push(...classified.inactive);

        state.checkpoints.push({
          workerId,
          countyIndex: county.countyIndex,
          state: county.state,
          county: county.county,
          population: county.population,
          pagesFetched: data.pagesFetched,
          chargedPageEvents,
          returnedCount: data.returnedCount,
          localVisibleElectricians: classified.candidates.length,
          sabHolds: classified.sabHolds.length,
          attempts,
          cumulativeCandidates: state.candidates.length,
          cumulativePageEvents: state.costGuard.actualPageEvents,
          at: new Date().toISOString()
        });

        writeJson(outputFile, { ...state, stopReason: 'IN_PROGRESS' });
        writeJson(summaryFile, {
          runId: state.runId,
          status: 'IN_PROGRESS',
          candidates: state.candidates.length,
          pageEvents: state.costGuard.actualPageEvents,
          countiesAttempted: state.countiesAttempted,
          countiesSucceeded: state.countiesSucceeded,
          countiesFailed: state.countiesFailed,
          lastCheckpoint: state.checkpoints.at(-1) || null
        });

        if (state.candidates.length >= targetCandidates) stopReason = 'TARGET_CANDIDATES_REACHED';
      } catch (error) {
        reservedPageEvents -= RESERVATION_PER_COUNTY;
        const attempts = Math.min(MAX_ATTEMPTS, Math.max(1, Number(error?.attempts || MAX_ATTEMPTS)));
        state.costGuard.actualPageEvents += attempts * MAX_PAGE_EVENTS_PER_ATTEMPT;
        state.countiesFailed++;
        state.errors.push({
          workerId,
          countyIndex: county.countyIndex,
          state: county.state,
          county: county.county,
          error: String(error?.message || error),
          at: new Date().toISOString()
        });
        const msg = String(error?.message || error);
        if (/ENTERPRISE|UNEXPECTED_SKU|UNEXPECTED_SOURCE_MODE|PROHIBITED_FIELD|EXPECTED_ID_OR_PAGINATION|INVALID_PAGES_FETCHED/.test(msg)) {
          stopReason = `FATAL_COST_FIREWALL:${msg}`;
          writeJson(outputFile, { ...state, stopReason });
          throw error;
        }
      }
    }
  }

  const workers = Array.from({ length: concurrency }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  state.completedAt = new Date().toISOString();
  state.candidates.sort((a, b) => b.countyRank - a.countyRank || b.sourcePopulation - a.sourcePopulation || a.businessName.localeCompare(b.businessName));
  state.stopReason = stopReason || 'UNKNOWN';
  const finalSummary = {
    runId: state.runId,
    status: state.stopReason.startsWith('FATAL') ? 'FAILED' : 'COMPLETE',
    stopReason: state.stopReason,
    targetCandidates,
    candidates: state.candidates.length,
    sabHolds: state.sabHolds.length,
    pageEvents: state.costGuard.actualPageEvents,
    maxPageEvents,
    countiesInput: state.countiesInput,
    countiesAttempted: state.countiesAttempted,
    countiesSucceeded: state.countiesSucceeded,
    countiesFailed: state.countiesFailed,
    outsideCountyNoise: state.outsideCountyNoise.length,
    unresolvedVisible: state.unresolvedVisible.length,
    typeNoise: state.typeNoise.length,
    inactive: state.inactive.length,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    lastCheckpoint: state.checkpoints.at(-1) || null
  };
  writeJson(outputFile, state);
  writeJson(summaryFile, finalSummary);
  console.log(JSON.stringify(finalSummary, null, 2));
  return finalSummary;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const requestPath = process.argv[2] || 'tools/afy-free-rank-gateway/batch-run-request.json';
  runBatch(requestPath).catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
