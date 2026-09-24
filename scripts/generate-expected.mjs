// Writes expected/*.json from mocks/reference.mjs. Run after changing the
// dataset or a rule; test/expected.test.mjs fails if they drift apart.
import fs from 'node:fs';
import { AS_OF } from '../mocks/data.mjs';
import { priceDrift, catalogueTotal, stuckOrders, supplierAccount, processedOffers, OFFER_CHAIN } from '../mocks/reference.mjs';

export function expectedFiles() {
  return {
    'processor_offers.json': {
      workspace: 'A',
      tool: 'mock_supplier_list_offers',
      chain: { rate: OFFER_CHAIN.rate, vat: OFFER_CHAIN.vat },
      calls: [
        { args: { category: 'fasteners' }, result: processedOffers('A', 'fasteners') },
        { args: { category: 'broken' }, result: 'error naming the path price_usd' },
      ],
    },
    'price_drift_check.json': {
      workspace: 'A',
      calls: [5, 10].map((threshold) => ({ args: { threshold }, result: priceDrift('A', threshold) })),
    },
    'catalogue_total.json': {
      workspace: 'A',
      calls: ['fasteners', 'adhesives', 'legacy'].map((category) => ({ args: { category }, result: catalogueTotal('A', category) })),
    },
    'stuck_orders.json': {
      workspace: 'A',
      calls: [3, 7].map((days) => ({ args: { days, as_of: AS_OF }, result: stuckOrders('A', days) })),
    },
    'supplier_account.json': { workspace: 'A', calls: [{ args: {}, result: supplierAccount('A') }] },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fs.mkdirSync('expected', { recursive: true });
  for (const [name, body] of Object.entries(expectedFiles())) {
    fs.writeFileSync(`expected/${name}`, `${JSON.stringify(body, null, 2)}\n`);
    console.log(`expected/${name}`);
  }
}
