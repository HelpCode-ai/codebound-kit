// Reference answers for the four functional scripts.
//
// This is the "correct" result computed straight from the dataset, not by
// calling the APIs. scripts/generate-expected.mjs writes these to
// expected/*.json, and the checker compares a team's script output against
// them. If you change a rule here, regenerate the expected files.

import { AS_OF, dataset } from './data.mjs';

const round1 = (n) => Math.round(n * 10) / 10;

/** Active articles whose supplier price is more than `threshold` % above the ERP purchase price. */
export function priceDrift(tenant, threshold) {
  const ds = dataset(tenant);
  return ds.articles
    .filter((a) => a.status === 'active' && ds.supplierPrices[a.sku] !== undefined)
    .map((a) => {
      const supplierPrice = ds.supplierPrices[a.sku];
      const driftPct = ((supplierPrice - a.purchasePrice) / a.purchasePrice) * 100;
      return { sku: a.sku, purchasePrice: a.purchasePrice, supplierPrice, driftPct: round1(driftPct) };
    })
    .filter((a) => a.driftPct > threshold)
    .sort((x, y) => y.driftPct - x.driftPct);
}

export const CATALOGUE_PAGE_SIZE = 50;

/** Walks every page of a catalogue category, the way a script has to. */
export function catalogueTotal(tenant, category) {
  const cat = dataset(tenant).catalogue[category];
  if (!cat) return { category, total: 0, complete: true };
  let total = 0;
  for (let page = 1; ; page++) {
    if (cat.failsFromPage && page >= cat.failsFromPage) return { category, total, complete: false };
    const items = cat.items.slice((page - 1) * CATALOGUE_PAGE_SIZE, page * CATALOGUE_PAGE_SIZE);
    if (items.length === 0) return { category, total, complete: true };
    total += items.length;
  }
}

/** Shipped orders whose parcel is not delivered and has not been scanned for more than `days` days. */
export function stuckOrders(tenant, days, asOf = AS_OF) {
  const ds = dataset(tenant);
  const cutoff = Date.parse(asOf) - days * 24 * 3600 * 1000;
  return ds.orders
    .filter((o) => o.status === 'shipped')
    .map((o) => ({ order: o, parcel: ds.parcels[o.trackingNo] }))
    .filter(({ parcel }) => parcel.status !== 'delivered' && Date.parse(parcel.lastScanAt) < cutoff)
    .sort((x, y) => Date.parse(x.parcel.lastScanAt) - Date.parse(y.parcel.lastScanAt))
    .map(({ order, parcel }) => ({
      orderNo: order.orderNo,
      trackingNo: parcel.trackingNo,
      status: parcel.status,
      lastScanAt: parcel.lastScanAt,
    }));
}

/** What GET /v1/account on the supplier returns for this tenant. */
export function supplierAccount(tenant) {
  const ds = dataset(tenant);
  return { accountName: ds.company, customerNo: ds.customerNo };
}

/** The processor chain every team configures on mock_supplier_list_offers. */
export const OFFER_CHAIN = { rate: 0.92, vat: 0.19 };

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * What mock_supplier_list_offers must return once the chain runs:
 * price_eur added (USD × rate), price_eur_gross added (EUR × (1 + vat)),
 * description replaced by its cleaned form (trimmed, single spaces).
 * Everything else untouched. Returns null for a category the chain must refuse.
 */
export function processedOffers(tenant, category) {
  const items = dataset(tenant).offers[category];
  if (!items) return null;
  if (items.some((o) => typeof o.price_usd !== 'number')) return null;
  return items.map((o) => {
    const price_eur = round2(o.price_usd * OFFER_CHAIN.rate);
    return { ...o, description: o.description.trim().replace(/\s+/g, ' '), price_eur, price_eur_gross: round2(price_eur * (1 + OFFER_CHAIN.vat)) };
  });
}
