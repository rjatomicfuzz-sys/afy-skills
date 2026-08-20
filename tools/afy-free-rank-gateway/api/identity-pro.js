const GOOGLE_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.businessStatus',
  'places.pureServiceAreaBusiness',
  'places.primaryType',
  'places.types',
  'places.location',
  'places.googleMapsUri',
  'places.containingPlaces',
  'nextPageToken'
].join(',');
const MAX_PAGES = 3;
const PAGE_SIZE = 20;

function cleanQuery(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ');
}

function allowedQuery(q) {
  // Locked to county identity enrichment only. No arbitrary queries.
  return /^electrician in .{2,120} County, .{2,60}$/i.test(q);
}

function extractAddressParts(parts) {
  const out = { city: null, county: null, state: null, stateCode: null, postalCode: null, country: null };
  if (!Array.isArray(parts)) return out;
  for (const p of parts) {
    const types = Array.isArray(p?.types) ? p.types : [];
    if (types.includes('locality')) out.city = p.longText || out.city;
    if (!out.city && types.includes('postal_town')) out.city = p.longText || out.city;
    if (!out.city && types.includes('administrative_area_level_3')) out.city = p.longText || out.city;
    if (types.includes('administrative_area_level_2')) out.county = p.longText || out.county;
    if (types.includes('administrative_area_level_1')) {
      out.state = p.longText || out.state;
      out.stateCode = p.shortText || out.stateCode;
    }
    if (types.includes('postal_code')) out.postalCode = p.longText || out.postalCode;
    if (types.includes('country')) out.country = p.shortText || p.longText || out.country;
  }
  return out;
}

async function googlePage(apiKey, textQuery, pageToken) {
  const body = {
    textQuery,
    pageSize: PAGE_SIZE,
    includePureServiceAreaBusinesses: true,
    rankPreference: 'RELEVANCE',
    regionCode: 'US',
    languageCode: 'en'
  };
  if (pageToken) body.pageToken = pageToken;

  const response = await fetch(GOOGLE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      // COST FIREWALL: hard-coded Pro-only identity fields. No Enterprise fields accepted.
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
      requiredPattern: 'electrician in <County> County, <State>'
    }, { status: 400 });
  }

  try {
    const places = [];
    const seen = new Set();
    let token = '';
    let pagesFetched = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await googlePage(apiKey, q, token);
      pagesFetched++;
      const pagePlaces = Array.isArray(data.places) ? data.places : [];

      for (const p of pagePlaces) {
        const placeId = p?.id;
        if (!placeId || seen.has(placeId)) continue;
        seen.add(placeId);
        const address = extractAddressParts(p?.addressComponents);
        places.push({
          rank: places.length + 1,
          placeId,
          displayName: p?.displayName?.text || null,
          formattedAddress: p?.formattedAddress || null,
          businessStatus: p?.businessStatus || null,
          pureServiceAreaBusiness: p?.pureServiceAreaBusiness === true,
          primaryType: p?.primaryType || null,
          types: Array.isArray(p?.types) ? p.types : [],
          location: p?.location || null,
          googleMapsUri: p?.googleMapsUri || null,
          containingPlaces: Array.isArray(p?.containingPlaces) ? p.containingPlaces : [],
          city: address.city,
          county: address.county,
          state: address.state,
          stateCode: address.stateCode,
          postalCode: address.postalCode,
          country: address.country
        });
      }

      token = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
      if (!token) break;
    }

    return Response.json({
      ok: true,
      sourceMode: 'TEXT_SEARCH_PRO_IDENTITY',
      billingSkuCeiling: 'TEXT_SEARCH_PRO',
      enterpriseFieldsRequested: false,
      billingFieldMask: FIELD_MASK,
      query: q,
      pageSize: PAGE_SIZE,
      pagesFetched,
      returnedCount: places.length,
      maxGoogleResults: 60,
      exhaustedWithinGoogleLimit: !token,
      places,
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
