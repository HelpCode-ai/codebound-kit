// The automated checks, in the order `codebound check` runs them.
//
// Processor checks (P) and script checks (F) call workspace A over MCP and
// compare with the reference answers. They also look at the mock APIs' request log: a
// script that returns the right rows without calling the ERP and the supplier
// has hardcoded them. Secret scans (S) look for the planted credentials in
// everything a person could read afterwards.
//
// The attack cards are a specification (cards/CARDS.md). Teams port them to
// their own script API and run them; the jury runs them live on Sunday.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { AS_OF } from '../mocks/data.mjs';
import { priceDrift, catalogueTotal, stuckOrders, supplierAccount, processedOffers, OFFER_CHAIN } from '../mocks/reference.mjs';

const pass = (details = []) => ({ status: 'pass', details });
const fail = (details = []) => ({ status: 'fail', details });
const skip = (details = []) => ({ status: 'skip', details });

/** Rows from a script result: a JSON array, or an object holding exactly one array. */
export function rowsOf(result) {
  const j = result.json;
  if (Array.isArray(j)) return j;
  if (j && typeof j === 'object') {
    const arrays = Object.values(j).filter(Array.isArray);
    if (arrays.length === 1) return arrays[0];
  }
  return null;
}

const near = (a, b) => typeof a === 'number' && Math.abs(a - b) <= 0.011;

export const CHECKS = [
  // ── Level 1: processor chains ───────────────────────────────────────────
  {
    id: 'P1', group: 'must', level: 1, title: 'A processor chain converts, adds VAT and cleans, before the mapping',
    tools: ['mock_supplier_list_offers'],
    expect: `mock_supplier_list_offers({category: "fasteners"}) returns all 30 offers with price_eur = price_usd × ${OFFER_CHAIN.rate} (added), price_eur_gross = price_eur × ${1 + OFFER_CHAIN.vat} (added), description trimmed to single spaces (replaced), every other field untouched. Values rounded to 2 decimals after each step.`,
    async run(ctx) {
      const r = await ctx.call('mock_supplier_list_offers', { category: 'fasteners' });
      if (!r.ok) return fail([`error: ${r.text.slice(0, 200)}`]);
      const rows = rowsOf(r);
      const want = processedOffers('A', 'fasteners');
      if (!rows) return fail([`output has no list of offers: ${r.text.slice(0, 150)}`]);
      if (rows.length !== want.length) return fail([`got ${rows.length} offers, want ${want.length}`]);
      const problems = [];
      rows.forEach((o, i) => {
        const w = want[i];
        if (o.itemNo !== w.itemNo) problems.push(`#${i + 1}: itemNo ${o.itemNo}, want ${w.itemNo} (order must be kept)`);
        else {
          if (!('price_eur' in o)) problems.push(`${w.itemNo}: price_eur missing (step 1, add)`);
          else if (!near(o.price_eur, w.price_eur)) problems.push(`${w.itemNo}: price_eur ${o.price_eur}, want ${w.price_eur}`);
          if (!('price_eur_gross' in o)) problems.push(`${w.itemNo}: price_eur_gross missing (step 2, add)`);
          else if (!near(o.price_eur_gross, w.price_eur_gross)) problems.push(`${w.itemNo}: price_eur_gross ${o.price_eur_gross}, want ${w.price_eur_gross}`);
          if (o.description !== w.description) problems.push(`${w.itemNo}: description ${JSON.stringify(o.description)}, want ${JSON.stringify(w.description)} (replace)`);
          for (const k of ['price_usd', 'currency', 'moq']) if (o[k] !== w[k]) problems.push(`${w.itemNo}: ${k} changed (${JSON.stringify(o[k])})`);
        }
      });
      if (!r.log.some((e) => e.service === 'supplier' && e.path === '/v1/offers' && e.tenant === 'A')) problems.push('the offers were not fetched from the supplier during the call');
      return problems.length ? fail([`${problems.length} problem(s)`, ...problems.slice(0, 6)]) : pass([`30 offers converted, VAT added, descriptions cleaned (${r.text.length} bytes)`]);
    },
  },
  {
    id: 'P2', group: 'must', level: 1, title: 'A broken input stops the chain, loudly',
    tools: ['mock_supplier_list_offers'],
    expect: 'mock_supplier_list_offers({category: "broken"}): one offer has price_usd "n/a". The call must fail with an error that names the path price_usd, instead of passing on raw or half-converted offers.',
    async run(ctx) {
      const r = await ctx.call('mock_supplier_list_offers', { category: 'broken' });
      if (r.ok) return fail(['the call succeeded: a broken price went through silently']);
      if (!/price_usd/.test(r.text)) return fail([`it failed, but the error does not name the path price_usd: ${r.text.slice(0, 200)}`]);
      return pass([`refused: ${r.text.replace(/\s+/g, ' ').slice(0, 140)}`]);
    },
  },

  // ── Level 2: scripts that call tools ────────────────────────────────────
  {
    id: 'F1', group: 'must', level: 2, title: 'Scripts are tools with typed parameters',
    tools: ['price_drift_check', 'catalogue_total', 'stuck_orders'],
    expect: 'tools/list on workspace A shows the three scripts. price_drift_check.threshold and stuck_orders.days are numbers; catalogue_total.category and stuck_orders.as_of are strings.',
    async run(ctx) {
      const want = {
        price_drift_check: { threshold: 'number' },
        catalogue_total: { category: 'string' },
        stuck_orders: { days: 'number', as_of: 'string' },
      };
      const details = [];
      for (const [name, params] of Object.entries(want)) {
        const tool = ctx.tool(name);
        for (const [p, type] of Object.entries(params)) {
          const t = tool.inputSchema?.properties?.[p]?.type;
          const types = Array.isArray(t) ? t : [t];
          if (!(types.includes(type) || (type === 'number' && types.includes('integer')))) {
            details.push(`${tool.name}: parameter "${p}" should be ${type}, is ${JSON.stringify(t ?? 'missing')}`);
          }
        }
      }
      return details.length ? fail(details) : pass(['all three scripts listed with typed parameters']);
    },
  },
  {
    id: 'F2', group: 'must', level: 2, title: 'price_drift_check: hundreds of records in, four rows out',
    tools: ['price_drift_check'],
    expect: 'threshold 5 → 4 rows, threshold 10 → 2 rows; SKUs and order as in expected/price_drift_check.json, driftPct within 0.15. The ERP articles and the supplier prices must actually be called.',
    async run(ctx) {
      const details = [];
      let ok = true;
      for (const threshold of [5, 10]) {
        const r = await ctx.call('price_drift_check', { threshold });
        const want = priceDrift('A', threshold);
        const rows = rowsOf(r);
        if (!r.ok || !rows) {
          ok = false;
          details.push(`threshold ${threshold}: ${r.ok ? 'output is not a JSON array of rows' : 'error'}: ${r.text.slice(0, 200)}`);
          continue;
        }
        const got = rows.map((x) => x?.sku);
        if (JSON.stringify(got) !== JSON.stringify(want.map((x) => x.sku))) {
          ok = false;
          details.push(`threshold ${threshold}: got ${JSON.stringify(got)}, want ${JSON.stringify(want.map((x) => x.sku))}`);
        } else {
          const off = rows.filter((x, i) => !(Math.abs(Number(x.driftPct) - want[i].driftPct) <= 0.15));
          if (off.length) {
            ok = false;
            details.push(`threshold ${threshold}: driftPct off for ${off.map((x) => x.sku).join(', ')}`);
          } else details.push(`threshold ${threshold}: ${rows.length} rows, correct, ${r.text.length} bytes returned`);
        }
        const used = new Set(r.log.filter((e) => e.tenant === 'A').map((e) => `${e.service} ${e.path}`));
        if (!used.has('erp /v1/articles') || !used.has('supplier /v1/prices')) {
          ok = false;
          details.push(`threshold ${threshold}: the ERP articles and the supplier prices were not both called (saw: ${[...used].join(', ') || 'nothing'})`);
        }
      }
      return ok ? pass(details) : fail(details);
    },
  },
  {
    id: 'F3', group: 'must', level: 2, title: 'catalogue_total walks every page and admits a broken source',
    tools: ['catalogue_total'],
    expect: 'fasteners {total: 800, complete: true}, adhesives {total: 137, complete: true}, legacy {total: 200, complete: false}.',
    async run(ctx) {
      const details = [];
      let ok = true;
      for (const category of ['fasteners', 'adhesives', 'legacy']) {
        const r = await ctx.call('catalogue_total', { category });
        const want = catalogueTotal('A', category);
        const got = r.json;
        if (!r.ok || !got || got.total !== want.total || got.complete !== want.complete) {
          ok = false;
          details.push(`${category}: got ${r.ok ? JSON.stringify(got ?? r.text.slice(0, 120)) : `error ${r.text.slice(0, 150)}`}, want ${JSON.stringify({ total: want.total, complete: want.complete })}`);
        } else details.push(`${category}: ${got.total} items, complete=${got.complete}`);
        if (!r.log.some((e) => e.service === 'supplier' && e.path === '/v1/catalogue' && e.tenant === 'A')) {
          ok = false;
          details.push(`${category}: no catalogue page was requested from the supplier`);
        }
      }
      return ok ? pass(details) : fail(details);
    },
  },
  {
    id: 'F4', group: 'must', level: 2, title: 'stuck_orders joins ERP orders with carrier tracking',
    tools: ['stuck_orders'],
    expect: `days 3 → 5 orders, days 7 → 2 orders, with as_of "${AS_OF}".`,
    async run(ctx) {
      const details = [];
      let ok = true;
      for (const days of [3, 7]) {
        const r = await ctx.call('stuck_orders', { days, as_of: AS_OF });
        const want = stuckOrders('A', days).map((x) => x.orderNo).sort();
        const rows = rowsOf(r);
        const got = rows ? rows.map((x) => x?.orderNo).sort() : null;
        if (!r.ok || JSON.stringify(got) !== JSON.stringify(want)) {
          ok = false;
          details.push(`days ${days}: got ${got ? JSON.stringify(got) : r.text.slice(0, 150)}, want ${JSON.stringify(want)}`);
        } else details.push(`days ${days}: ${got.length} stuck orders, correct`);
        const used = new Set(r.log.filter((e) => e.tenant === 'A').map((e) => e.service));
        if (!used.has('erp') || !used.has('carrier')) {
          ok = false;
          details.push(`days ${days}: the ERP orders and the carrier were not both called`);
        }
      }
      return ok ? pass(details) : fail(details);
    },
  },

  // ── Level 3: scripts with secrets (a Should) ────────────────────────────
  {
    id: 'F5', group: 'should', level: 3, title: 'supplier_account uses the injected key for a direct call',
    tools: ['supplier_account'],
    expect: 'Returns {accountName: "Alpha Hardware GmbH", customerNo: "A-CUST-4711"} from GET /v1/account, which no tool exposes. The key must not be in the output.',
    async run(ctx) {
      const r = await ctx.call('supplier_account', {});
      if (!r.ok) return fail([`error: ${r.text.slice(0, 200)}`]);
      const want = supplierAccount('A');
      const details = [];
      if (r.json?.accountName !== want.accountName || r.json?.customerNo !== want.customerNo) details.push(`got ${r.text.slice(0, 150)}, want ${JSON.stringify(want)}`);
      if (!r.log.some((e) => e.service === 'supplier' && e.path === '/v1/account' && e.tenant === 'A')) details.push('no GET /v1/account with workspace A\'s key reached the supplier during the run');
      const leaked = ctx.leaks(r.text);
      if (leaked.length) details.push(`output contains ${leaked.join(', ')}`);
      return details.length ? fail(details) : pass(['account read with the injected key; key not in the output']);
    },
  },

  // ── Secret scans ────────────────────────────────────────────────────────
  {
    id: 'S1', group: 'scan', title: 'No credential in any script output of this run',
    expect: 'None of the planted credentials appears in anything the checker received.',
    async run(ctx) {
      const hits = [];
      for (const o of ctx.outputs) for (const label of ctx.leaks(o.text)) hits.push(`${o.label}: ${label}`);
      if (!ctx.outputs.length) return skip(['no script output collected (run the functional checks too)']);
      return hits.length ? fail(hits) : pass([`${ctx.outputs.length} outputs scanned`]);
    },
  },
  {
    id: 'S2', group: 'scan', title: 'No credential in the backend logs',
    expect: 'Docker mode: `docker logs` of the app container since the run started. Host mode: the file named in codebound.team.json → logs.file.',
    async run(ctx) {
      let text;
      if (ctx.team.logs?.file) {
        if (!fs.existsSync(ctx.team.logs.file)) return fail([`log file ${ctx.team.logs.file} does not exist`]);
        text = fs.readFileSync(ctx.team.logs.file, 'utf8');
      } else if (ctx.team.logs?.docker) {
        try {
          text = execFileSync('docker', ['logs', '--since', ctx.startedAt, ctx.team.logs.docker], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
          return fail([`could not read logs of container ${ctx.team.logs.docker}: ${err.message.split('\n')[0]}`]);
        }
      } else {
        return skip(['no log source configured: set logs.docker or logs.file in codebound.team.json (the jury run requires one)']);
      }
      const leaked = ctx.leaks(text);
      return leaked.length ? fail([`logs contain ${leaked.join(', ')}`]) : pass([`${Math.round(text.length / 1024)} KB of logs scanned`]);
    },
  },
  {
    id: 'S3', group: 'scan', title: 'No credential stored in plaintext in the database',
    expect: 'pg_dump of the whole database except connectors.env_vars, where AnythingMCP already keeps connector variables today. Audit rows, run records, caches: nothing may hold a credential in clear.',
    async run(ctx) {
      const pg = ctx.team.postgres;
      if (!pg?.docker) return skip(['no database configured: set postgres.docker in codebound.team.json (the jury run requires one)']);
      let dump;
      try {
        dump = execFileSync('docker', ['exec', pg.docker, 'pg_dump', '-U', pg.user || 'amcp', '-d', pg.db || 'anythingmcp', '--data-only', '--no-owner', '--exclude-table-data=public.connectors'], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
        // connectors is excluded above as a whole; dump it again without the one column that may hold variables.
        dump += execFileSync('docker', ['exec', pg.docker, 'psql', '-U', pg.user || 'amcp', '-d', pg.db || 'anythingmcp', '-At', '-c', 'SELECT row_to_json(c)::jsonb - \'env_vars\' FROM connectors c'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      } catch (err) {
        return fail([`could not dump the database from container ${pg.docker}: ${err.message.split('\n')[0]}`]);
      }
      const leaked = ctx.leaks(dump);
      return leaked.length ? fail([`database contains ${leaked.join(', ')}`]) : pass([`${Math.round(dump.length / 1024)} KB of data scanned`]);
    },
  },
];

export function printCards() {
  for (const c of CHECKS) {
    console.log(`\n${c.id}  ${c.title}`);
    if (c.level) console.log(`    level ${c.level}${c.group === 'should' ? ' (Should)' : ''}`);
    if (c.tools) console.log(`    calls: ${c.tools.join(', ')} (as alice, workspace A)`);
    console.log(`    expects: ${c.expect}`);
  }
  console.log('\nThe attack cards are in cards/CARDS.md. Port them to your script API and run them yourselves.');
}
