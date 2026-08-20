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
for (let i = 0; i < data.candidates.length; i += chunkSize) {
  const rows = data.candidates.slice(i, i + chunkSize).map(c => Object.fromEntries(fields.map(f => [f, c[f] ?? null])));
  const file = `candidates-${String(chunks.length + 1).padStart(3,'0')}.json`;
  fs.writeFileSync(path.join(outDir, file), JSON.stringify(rows, null, 2) + '\n');
  chunks.push({ file, start: i + 1, end: i + rows.length, count: rows.length });
}
const manifest = { runId: data.runId, totalCandidates: data.candidates.length, chunkSize, chunks };
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
