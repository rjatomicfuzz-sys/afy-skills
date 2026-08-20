import fs from 'node:fs';
import path from 'node:path';

const input = process.argv[2] || 'tools/afy-free-rank-gateway/output/latest.json';
const outDir = process.argv[3] || 'tools/afy-free-rank-gateway/output/chunks';
const chunkSize = Math.max(1, Number(process.argv[4] || 20));
const data = JSON.parse(fs.readFileSync(input, 'utf8'));
if (!Array.isArray(data.candidates)) throw new Error('candidates missing');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const fields = ['countyIndex','fips','state','sourceCounty','sourcePopulation','businessName','placeId','countyRank','countyResultCount','city','liveAddress'];
const chunks = [];

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"','""')}"` : s;
}

function sheetRow(r, globalIndex) {
  return [
    `BATCH-R1-${String(globalIndex).padStart(4,'0')}`,
    data.runId,
    r.countyIndex,
    r.fips,
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
for (let i = 0; i < data.candidates.length; i += chunkSize) {
  const rows = data.candidates.slice(i, i + chunkSize).map(c => Object.fromEntries(fields.map(f => [f, c[f] ?? null])));
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
const manifest = { runId: data.runId, totalCandidates: data.candidates.length, chunkSize, sheetAll: 'sheet-all.csv', chunks };
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
