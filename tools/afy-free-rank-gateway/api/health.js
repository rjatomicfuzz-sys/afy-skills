export function GET() {
  return Response.json({ ok: true, service: 'AFY_FREE_RANK_GATEWAY', googleCalled: false, sourceMode: 'IDS_ONLY_FREE' });
}
