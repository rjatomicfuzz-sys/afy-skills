const GOOGLE_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = 'places.id,nextPageToken';
const MAX_PAGES = 3;
const PAGE_SIZE = 20;

function cleanQuery(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ');
}

function allowedQuery(q) {
  // Deliberately narrow. This endpoint is only a free AFY electrician visibility census.
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
      // COST FIREWALL: never accept a client-supplied field mask.
      // places.id + nextPageToken are Text Search Essentials (IDs Only).
      'X-Goog-FieldMask': FIELD_MASK
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); }
  catch { data = { raw: text }; }

  if (!response.ok) {
    const err = new Error(`Google Places ${response.status}`);
    err.httpStatus = response.status;
    err.googleBody = data;
    throw err;
  }
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'GOOGLE_MAPS_API_KEY_MISSING' });
  }

  const q = cleanQuery(req.query?.q);
  if (!q || !allowedQuery(q)) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_QUERY',
      requiredPattern: 'electrician in <town/county>, <state>'
    });
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

    return res.status(200).json({
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
    });
  } catch (err) {
    const status = Number(err?.httpStatus) || 502;
    return res.status(status).json({
      ok: false,
      error: 'GOOGLE_PLACES_ERROR',
      googleHttpStatus: err?.httpStatus || null,
      googleError: err?.googleBody || null
    });
  }
}
