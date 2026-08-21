const GOOGLE_BASE = 'https://places.googleapis.com/v1/places/';

// FINALIZER COST FIREWALL:
// This route can request paid Enterprise Place Details fields, so it is hard-disabled
// by default. R2 grinders must use the free-first evidence path and /api/rank-ids.
const FIELD_MASK = [
  'id',
  'displayName',
  'formattedAddress',
  'businessStatus',
  'websiteUri',
  'rating',
  'userRatingCount',
  'nationalPhoneNumber'
].join(',');

function cleanPlaceId(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function allowedPlaceId(placeId) {
  return /^ChIJ[A-Za-z0-9_-]{8,220}$/.test(placeId);
}

export async function GET(request) {
  if (process.env.AFY_ENABLE_ENTERPRISE_FINALIZER !== 'true') {
    return Response.json({
      ok: false,
      error: 'ENTERPRISE_FINALIZER_DISABLED',
      enterpriseAllowed: false,
      guidance: 'Use the free-first grinder evidence path and /api/rank-ids.'
    }, {
      status: 403,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return Response.json({ ok: false, error: 'GOOGLE_MAPS_API_KEY_MISSING' }, { status: 500 });
  }

  const url = new URL(request.url);
  const placeId = cleanPlaceId(url.searchParams.get('placeId'));
  if (!allowedPlaceId(placeId)) {
    return Response.json({
      ok: false,
      error: 'INVALID_PLACE_ID',
      required: 'Known Google Place ID beginning ChIJ'
    }, { status: 400 });
  }

  try {
    const response = await fetch(`${GOOGLE_BASE}${encodeURIComponent(placeId)}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK
      }
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch { data = { raw: text }; }

    if (!response.ok) {
      return Response.json({
        ok: false,
        error: 'GOOGLE_PLACES_ERROR',
        googleHttpStatus: response.status,
        googleError: data
      }, { status: response.status });
    }

    return Response.json({
      ok: true,
      sourceMode: 'PLACE_DETAILS_ENTERPRISE_FINALIZER',
      billingSkuCeiling: 'PLACE_DETAILS_ENTERPRISE',
      enterpriseFieldsRequested: true,
      reviewsRequested: false,
      billingFieldMask: FIELD_MASK,
      placeId,
      place: {
        id: data?.id || null,
        displayName: data?.displayName?.text || null,
        formattedAddress: data?.formattedAddress || null,
        businessStatus: data?.businessStatus || null,
        websiteUri: data?.websiteUri || null,
        rating: Number.isFinite(data?.rating) ? data.rating : null,
        userRatingCount: Number.isInteger(data?.userRatingCount) ? data.userRatingCount : null,
        nationalPhoneNumber: data?.nationalPhoneNumber || null
      }
    }, {
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch (error) {
    return Response.json({
      ok: false,
      error: 'FINALIZER_INTERNAL_ERROR',
      detail: String(error?.message || error)
    }, { status: 502 });
  }
}
