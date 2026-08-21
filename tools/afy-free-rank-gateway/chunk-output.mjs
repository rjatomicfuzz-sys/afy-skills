import fs from 'node:fs';
import path from 'node:path';

const input = process.argv[2] || 'tools/afy-free-rank-gateway/output/latest.json';
const outDir = process.argv[3] || 'tools/afy-free-rank-gateway/output/chunks';
const chunkSize = Math.max(1, Number(process.argv[4] || 20));
const data = JSON.parse(fs.readFileSync(input, 'utf8'));
if (!Array.isArray(data.candidates)) throw new Error('candidates missing');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const STATE_CODES = Object.freeze({
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO',
  Connecticut: 'CT', Delaware: 'DE', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID',
  Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA',
  Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS',
  Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ',
  'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH',
  Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT', Virginia: 'VA',
  Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY', 'District of Columbia': 'DC'
});

function hasCorrectState(candidate) {
  const expected = STATE_CODES[candidate?.state];
  const actual = String(candidate?.stateCode || '').toUpperCase();
  return Boolean(expected && actual && expected === actual);
}

function batchRowPrefix(runId) {
  const match = String(runId || '').match(/(?:^|_)R(\d+)$/i);
  if (!match) throw new Error(`RUN_ID_ROUND_SUFFIX_REQUIRED:${runId || ''}`);
  return `BATCH-R${Number(match[1])}`;
}

const rowPrefix = batchRowPrefix(data.runId);
const preGeoCandidates = data.candidates.length;
const geoExcludedRecords = data.candidates.filter(c => !hasCorrectState(c));
const candidates = data.candidates.filter(hasCorrectState);
fs.writeFileSync(path.join(outDir, 'geo-excluded.json'), JSON.stringify(geoExcludedRecords, null, 2) + '\n');

const fields = ['countyIndex','fips','state','sourceCounty','sourcePopulation','businessName','placeId','countyRank','countyResultCount','city','liveAddress'];
const chunks = [];

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"','""')}"` : s;
}

function sheetRow(r, globalIndex) {
  return [
    `${rowPrefix}-${String(globalIndex).padStart(4,'0')}`,
    data.runId,
    r.countyIndex,
    `'${String(r.fips || '').padStart(5,'0')}`,
    r.state,
    r.sourceCounty,
    r.sourcePopulation,
    r.businessName,
    r.placeId,
    '',
    r.countyRank,
    r.countyResultCount,
    r.city,
    r.liveAddress,
    'OPERATIONAL',
    'TEXT_SEARCH_PRO_IDENTITY',
    ''
  ].map(csvCell).join(',');
}

const allSheetRows = [];
for (let i = 0; i < candidates.length; i += chunkSize) {
  const rows = candidates.slice(i, i + chunkSize).map(c => Object.fromEntries(fields.map(f => [f, c[f] ?? null])));
  const seq = String(chunks.length + 1).padStart(3,'0');
  const jsonFile = `candidates-${seq}.json`;
  const csvFile = `sheet-${seq}.csv`;
  fs.writeFileSync(path.join(outDir, jsonFile), JSON.stringify(rows, null, 2) + '\n');
  const csvRows = rows.map((r, j) => sheetRow(r, i + j + 1));
  fs.writeFileSync(path.join(outDir, csvFile), csvRows.join('\n') + '\n');
  allSheetRows.push(...csvRows);
  chunks.push({ file: jsonFile, csvFile, start: i + 1, end: i + rows.length, count: rows.length });
}
fs.writeFileSync(path.join(outDir, 'sheet-all.csv'), allSheetRows.join('\n') + '\n');
const manifest = {
  runId: data.runId,
  rowPrefix,
  preGeoCandidates,
  geoExcluded: geoExcludedRecords.length,
  totalCandidates: candidates.length,
  chunkSize,
  sheetAll: 'sheet-all.csv',
  geoExcludedFile: 'geo-excluded.json',
  chunks
};
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
