// Deterministic datasets for the CODEBOUND mock APIs.
//
// Every number here is generated from a fixed seed, so the same tenant always
// gets the same articles, prices, orders and parcels. That is what makes the
// expected outputs in expected/*.json possible: a team can run its scripts
// against these APIs and compare, without anyone having to eyeball a result.
//
// Two tenants exist, A (workspace "Alpha") and B (workspace "Beta"). Every id
// carries the tenant letter as a prefix (A-10001, BTRK000017, A-EMP-003), so
// data from the wrong workspace is recognisable anywhere it turns up.

export const AS_OF = '2026-10-16T12:00:00.000Z';

const TENANTS = {
  A: {
    seed: 0xa1fa,
    company: 'Alpha Hardware GmbH',
    customerNo: 'A-CUST-4711',
    catalogue: { fasteners: 800, adhesives: 137, legacy: { total: 450, failsFromPage: 5 } },
    // Hand-placed price drift. Indices are into the article list (0-based).
    drift: {
      bigActive: [[17, 0.125], [233, 0.18]], // > 10 %
      midActive: [[58, 0.062], [301, 0.079]], // > 5 %, <= 10 %
      inactive: [[27, 0.09], [99, 0.22], [360, 0.15]], // excluded: not active
      decrease: [[120, -0.2]],
      missing: [44, 412], // the supplier has no price for these
    },
    stuck: { recent: [4, 11, 23], old: [31, 47], deliveredOld: [52] },
  },
  B: {
    seed: 0xbe7a,
    company: 'Beta Baustoffe AG',
    customerNo: 'B-CUST-0815',
    catalogue: { fasteners: 650, adhesives: 91, legacy: { total: 300, failsFromPage: 3 } },
    drift: {
      bigActive: [[5, 0.14], [77, 0.11], [290, 0.3]],
      midActive: [[140, 0.07]],
      inactive: [[18, 0.12]],
      decrease: [[200, -0.1]],
      missing: [300],
    },
    stuck: { recent: [2, 9], old: [15, 21, 38], deliveredOld: [40] },
  },
};

export const TENANT_IDS = Object.keys(TENANTS);

export function tenantInfo(tenant) {
  const t = TENANTS[tenant];
  if (!t) throw new Error(`unknown tenant ${tenant}`);
  return t;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

const NOUNS = ['Hinge', 'Screw', 'Anchor', 'Bracket', 'Seal', 'Bolt', 'Latch', 'Rail', 'Clamp', 'Washer', 'Handle', 'Lock', 'Plate', 'Rivet', 'Spacer'];
const ADJ = ['Steel', 'Brass', 'Zinc-plated', 'Stainless', 'Heavy-duty', 'Fire-rated', 'Galvanised', 'Nylon', 'Aluminium', 'Black'];
const CATEGORIES = ['fasteners', 'hinges', 'seals', 'locks', 'tools'];
const CUSTOMERS = ['Bäckerei Huber', 'Schreinerei Wald', 'Stadtwerke Kehl', 'Fensterbau Rhein', 'Metallbau Lahr', 'Hotel Schwarzwald', 'Autohaus Brenner', 'Klinik am See'];

const cache = new Map();

export function dataset(tenant) {
  if (cache.has(tenant)) return cache.get(tenant);
  const t = tenantInfo(tenant);
  const rnd = mulberry32(t.seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  // ── Articles (ERP) and supplier prices ──────────────────────────────────
  const articles = [];
  for (let i = 0; i < 450; i++) {
    articles.push({
      sku: `${tenant}-${10001 + i}`,
      name: `${pick(ADJ)} ${pick(NOUNS)} ${Math.floor(rnd() * 90) + 10}mm`,
      category: pick(CATEGORIES),
      // Exactly 50 of 450 are inactive: every ninth article.
      status: i % 9 === 0 ? 'inactive' : 'active',
      purchasePrice: round2(0.5 + rnd() * 249.5),
      unit: pick(['pc', 'box', 'pack']),
    });
  }

  const driftByIndex = new Map();
  for (const [i, d] of [...t.drift.bigActive, ...t.drift.midActive, ...t.drift.inactive, ...t.drift.decrease]) {
    driftByIndex.set(i, d);
  }
  const missing = new Set(t.drift.missing);
  const supplierPrices = {};
  articles.forEach((a, i) => {
    if (missing.has(i)) return;
    // Background noise stays within +/- 3 %, so it never crosses a 5 % threshold.
    const d = driftByIndex.has(i) ? driftByIndex.get(i) : (rnd() * 0.06 - 0.03);
    supplierPrices[a.sku] = round2(a.purchasePrice * (1 + d));
  });
  for (const [i] of [...t.drift.bigActive, ...t.drift.midActive]) {
    if (articles[i].status !== 'active') throw new Error(`drift fixture ${tenant}:${i} is not active`);
  }
  for (const [i] of t.drift.inactive) {
    if (articles[i].status !== 'inactive') throw new Error(`inactive fixture ${tenant}:${i} is active`);
  }

  // ── Supplier catalogue ──────────────────────────────────────────────────
  const catalogue = {};
  for (const [cat, spec] of Object.entries(t.catalogue)) {
    const total = typeof spec === 'number' ? spec : spec.total;
    const prefix = cat.slice(0, 3).toUpperCase();
    catalogue[cat] = {
      failsFromPage: typeof spec === 'number' ? null : spec.failsFromPage,
      items: Array.from({ length: total }, (_, i) => ({
        itemNo: `${tenant}-${prefix}-${String(i + 1).padStart(4, '0')}`,
        description: `${pick(ADJ)} ${pick(NOUNS)}`,
        price: round2(0.2 + rnd() * 80),
      })),
    };
  }

  // ── Orders (ERP) and parcels (carrier) ──────────────────────────────────
  const asOf = Date.parse(AS_OF);
  const hour = 3600 * 1000;
  const orders = [];
  const parcels = {};
  let shippedIdx = 0;
  for (let i = 0; i < 120; i++) {
    const orderNo = `${tenant}-ORD-${String(i + 1).padStart(5, '0')}`;
    // Every second order has shipped; the rest are still open.
    const shipped = i % 2 === 0;
    const order = {
      orderNo,
      customer: pick(CUSTOMERS),
      total: round2(50 + rnd() * 4000),
      status: shipped ? 'shipped' : 'open',
      createdAt: new Date(asOf - (20 + Math.floor(rnd() * 200)) * hour).toISOString(),
    };
    if (shipped) {
      const trackingNo = `${tenant}TRK${String(shippedIdx + 1).padStart(6, '0')}`;
      order.trackingNo = trackingNo;
      order.shippedAt = new Date(asOf - (30 + Math.floor(rnd() * 250)) * hour).toISOString();
      let status;
      let hoursAgo;
      if (t.stuck.recent.includes(shippedIdx)) {
        status = shippedIdx % 2 ? 'exception' : 'in_transit';
        hoursAgo = 4 * 24 + 1 + Math.floor(rnd() * 44); // 4-6 days
      } else if (t.stuck.old.includes(shippedIdx)) {
        status = 'in_transit';
        hoursAgo = 8 * 24 + 1 + Math.floor(rnd() * 44); // 8-10 days
      } else if (t.stuck.deliveredOld.includes(shippedIdx)) {
        status = 'delivered';
        hoursAgo = 12 * 24; // old but delivered: never stuck
      } else if (rnd() < 0.7) {
        status = 'delivered';
        hoursAgo = 1 + Math.floor(rnd() * 150);
      } else {
        status = 'in_transit';
        hoursAgo = 1 + Math.floor(rnd() * 47); // under 2 days: moving
      }
      parcels[trackingNo] = {
        trackingNo,
        status,
        lastScanAt: new Date(asOf - hoursAgo * hour).toISOString(),
        lastScanLocation: pick(['Freiburg', 'Offenburg', 'Karlsruhe', 'Basel', 'Stuttgart']),
      };
      shippedIdx++;
    }
    orders.push(order);
  }

  // ── Supplier offers in USD (the processor-chain exercise) ───────────────
  // Descriptions arrive messy on purpose: the `replace` case cleans them.
  // One category is broken on purpose: a price that is not a number, so a
  // chain has to stop with an error instead of passing half a result on.
  const messy = (text) => `${rnd() < 0.5 ? '  ' : ' '}${text.replace(/ /g, () => (rnd() < 0.4 ? '   ' : ' '))}${rnd() < 0.5 ? '  ' : ''}`;
  const offer = (cat, i) => ({
    itemNo: `${tenant}-OFF-${cat.slice(0, 3).toUpperCase()}-${String(i + 1).padStart(3, '0')}`,
    description: messy(`${pick(ADJ)} ${pick(NOUNS)} ${Math.floor(rnd() * 90) + 10}mm`),
    price_usd: round2(1 + rnd() * 400),
    currency: 'USD',
    moq: pick([1, 5, 10, 50, 100]),
  });
  const offers = {
    fasteners: Array.from({ length: 30 }, (_, i) => offer('fasteners', i)),
    broken: Array.from({ length: 5 }, (_, i) => offer('broken', i)),
  };
  offers.broken[3].price_usd = 'n/a';

  // ── Payroll (only workspace A imports this connector) ───────────────────
  const employees = Array.from({ length: 12 }, (_, i) => ({
    employeeId: `${tenant}-EMP-${String(i + 1).padStart(3, '0')}`,
    name: `${pick(['Anna', 'Jonas', 'Lea', 'Felix', 'Mia', 'Paul', 'Emma', 'Ben'])} ${pick(['Müller', 'Schmidt', 'Weber', 'Fischer', 'Wagner', 'Becker'])}`,
    monthlySalary: round2(2800 + rnd() * 5200),
    iban: `DE${String(Math.floor(rnd() * 1e18)).padStart(20, '0')}`,
  }));

  const ds = { tenant, company: t.company, customerNo: t.customerNo, articles, supplierPrices, catalogue, orders, parcels, employees, offers };
  cache.set(tenant, ds);
  return ds;
}
