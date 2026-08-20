const GOOGLE_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = 'places.id,nextPageToken';
const MAX_PAGES = 3;
const PAGE_SIZE = 20;

function cleanQuery(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ');
}

function allowedQuery(q) {
  return /^electrician in .{2,180}$/i.test(q);
}

async function googlePage(apiKey, textQuery, pageToken) {
  const body = {
    textQuery,
    pageSize: PAGE_SIZE,
    includePureServiceAreaBusinesses: true,
    rankPreference: 'RELEVANCE'
  };
  if (pageToken) body.pageToken = pageToken;

  const response = await fetch(GOOGLE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); }
  catch { data = { raw: text }; }

  if (!response.ok) {
    const error = new Error(`Google Places ${response.status}`);
    error.httpStatus = response.status;
    error.googleBody = data;
    throw error;
  }
  return data;
}

export async function GET(request) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return Response.json({ ok: false, error: 'GOOGLE_MAPS_API_KEY_MISSING' }, { status: 500 });
  }

  const url = new URL(request.url);
  const q = cleanQuery(url.searchParams.get('q'));
  if (!q || !allowedQuery(q)) {
    return Response.json({
      ok: false,
      error: 'INVALID_QUERY',
      requiredPattern: 'electrician in <town/county>, <state>'
    }, { status: 400 });
  }

  try {
    const ranked = [];
    const seen = new Set();
    let token = '';
    let pagesFetched = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await googlePage(apiKey, q, token);
      pagesFetched++;
      const places = Array.isArray(data.places) ? data.places : [];

      for (const p of places) {
        const id = p?.id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ranked.push({ rank: ranked.length + 1, placeId: id });
      }

      token = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
      if (!token) break;
    }

    return Response.json({
      ok: true,
      sourceMode: 'IDS_ONLY_FREE',
      billingFieldMask: FIELD_MASK,
      query: q,
      pageSize: PAGE_SIZE,
      pagesFetched,
      returnedCount: ranked.length,
      maxGoogleResults: 60,
      exhaustedWithinGoogleLimit: !token,
      ranked,
      nextPageTokenAfterMaxPages: token || null
    }, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) {
    const status = Number(error?.httpStatus) || 502;
    return Response.json({
      ok: false,
      error: 'GOOGLE_PLACES_ERROR',
      googleHttpStatus: error?.httpStatus || null,
      googleError: error?.googleBody || null
    }, { status });
  }
}
