import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJurisdiction, isElectricianType, validateGatewayPayload, classifyCountyResult } from './batch-runner.mjs';

test('normalizes county suffixes safely', () => {
  assert.equal(normalizeJurisdiction('Clay County'), 'clay');
  assert.equal(normalizeJurisdiction('St. Clair County'), 'st clair');
  assert.equal(normalizeJurisdiction('Northeastern Connecticut Planning Region'), 'northeastern connecticut');
});

test('electrician type signal accepts primary or secondary type', () => {
  assert.equal(isElectricianType({ primaryType: 'electrician', types: [] }), true);
  assert.equal(isElectricianType({ primaryType: 'general_contractor', types: ['electrician'] }), true);
  assert.equal(isElectricianType({ primaryType: 'plumber', types: ['plumber'] }), false);
});

test('cost firewall accepts exact Pro identity payload', () => {
  const payload = {
    ok: true,
    sourceMode: 'TEXT_SEARCH_PRO_IDENTITY',
    billingSkuCeiling: 'TEXT_SEARCH_PRO',
    enterpriseFieldsRequested: false,
    billingFieldMask: 'places.id,places.displayName,places.formattedAddress,places.addressComponents,places.businessStatus,places.pureServiceAreaBusiness,places.primaryType,places.types,places.location,places.googleMapsUri,places.containingPlaces,nextPageToken',
    pagesFetched: 3,
    places: []
  };
  assert.equal(validateGatewayPayload(payload), true);
});

test('cost firewall rejects Enterprise website field', () => {
  assert.throws(() => validateGatewayPayload({
    ok: true,
    sourceMode: 'TEXT_SEARCH_PRO_IDENTITY',
    billingSkuCeiling: 'TEXT_SEARCH_PRO',
    enterpriseFieldsRequested: false,
    billingFieldMask: 'places.id,places.websiteUri,nextPageToken',
    pagesFetched: 1,
    places: []
  }), /PROHIBITED_FIELD/);
});

test('classification keeps only operational local visible electricians as candidates', () => {
  const county = { countyIndex: 478, state: 'Illinois', county: 'Clay', fips: '17025', population: 12793 };
  const data = {
    sourceMode: 'TEXT_SEARCH_PRO_IDENTITY', billingSkuCeiling: 'TEXT_SEARCH_PRO', returnedCount: 60,
    places: [
      { rank: 45, placeId: 'local', displayName: 'Local Electric', businessStatus: 'OPERATIONAL', pureServiceAreaBusiness: false, primaryType: 'electrician', types: ['electrician'], county: 'Clay County', formattedAddress: '1 Main St', city: 'Flora' },
      { rank: 2, placeId: 'outside', displayName: 'Outside Electric', businessStatus: 'OPERATIONAL', pureServiceAreaBusiness: false, primaryType: 'electrician', types: ['electrician'], county: 'Marion County', formattedAddress: '2 Main St' },
      { rank: 3, placeId: 'sab', displayName: 'SAB Electric', businessStatus: 'OPERATIONAL', pureServiceAreaBusiness: true, primaryType: 'electrician', types: ['electrician'], county: null, formattedAddress: null },
      { rank: 4, placeId: 'noise', displayName: 'Hardware', businessStatus: 'OPERATIONAL', pureServiceAreaBusiness: false, primaryType: 'hardware_store', types: ['hardware_store'], county: 'Clay County', formattedAddress: '3 Main St' },
      { rank: 5, placeId: 'closed', displayName: 'Closed Electric', businessStatus: 'CLOSED_PERMANENTLY', pureServiceAreaBusiness: false, primaryType: 'electrician', types: ['electrician'], county: 'Clay County', formattedAddress: '4 Main St' }
    ]
  };
  const out = classifyCountyResult(county, data, '2026-08-20T00:00:00Z');
  assert.deepEqual(out.candidates.map(x => x.placeId), ['local']);
  assert.deepEqual(out.outsideCounty.map(x => x.placeId), ['outside']);
  assert.deepEqual(out.sabHolds.map(x => x.placeId), ['sab']);
  assert.deepEqual(out.typeNoise.map(x => x.placeId), ['noise']);
  assert.deepEqual(out.inactive.map(x => x.placeId), ['closed']);
});
