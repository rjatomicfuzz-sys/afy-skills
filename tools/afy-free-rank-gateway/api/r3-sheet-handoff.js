import { readFile } from 'node:fs/promises';

export async function GET() {
  try {
    const csv = await readFile(new URL('../output/chunks/sheet-all.csv', import.meta.url), 'utf8');
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch (error) {
    return Response.json({ ok: false, error: 'HANDOFF_READ_FAILED', detail: String(error?.message || error) }, { status: 500 });
  }
}
