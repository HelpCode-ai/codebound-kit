// A fake "team" for testing the checker itself. NOT a sandbox and not a model
// answer: the four scripts run in this process and call the real gateway over
// MCP as alice. `--leaky` makes supplier_account return the key, so the
// self-test can prove the checker notices.
//
//   node test/fake-team.mjs [--leaky]   → MCP on http://127.0.0.1:4390/mcp

import http from 'node:http';
import { loadState } from '../harness/state.mjs';
import { McpClient } from '../harness/mcp.mjs';

const leaky = process.argv.includes('--leaky');
const state = loadState();
const gateway = new McpClient(`${state.url}/mcp/${state.workspaces.A.serverId}`, state.users.alice.key);
const tool = async (name, args) => {
  const r = await gateway.callTool(name, args);
  if (!r.ok) throw new Error(`${name}: ${r.text.slice(0, 200)}`);
  return r.json;
};

const round2 = (n) => Math.round(n * 100) / 100;

const SCRIPTS = {
  // Stands in for the gateway tool with a processor chain on it.
  mock_supplier_list_offers: {
    exact: true,
    inputSchema: { type: 'object', properties: { category: { type: 'string' } }, required: ['category'] },
    async run({ category }) {
      const raw = await tool('mock_supplier_list_offers', { category });
      const items = raw.items.map((o, i) => {
        if (typeof o.price_usd !== 'number') throw new Error(`step convert_to_eur: $.items[${i}].price_usd is not a number`);
        const price_eur = round2(o.price_usd * 0.92);
        return { ...o, description: o.description.trim().replace(/\s+/g, ' '), price_eur, price_eur_gross: round2(price_eur * 1.19) };
      });
      return { category, items };
    },
  },
  price_drift_check: {
    inputSchema: { type: 'object', properties: { threshold: { type: 'number' } }, required: ['threshold'] },
    async run({ threshold = 5 }) {
      const articles = [];
      for (let page = 1; ; page++) {
        const r = await tool('mock_erp_list_articles', { status: 'active', page, pageSize: 100 });
        articles.push(...r.items);
        if (page >= r.totalPages) break;
      }
      const prices = {};
      for (let i = 0; i < articles.length; i += 100) {
        Object.assign(prices, (await tool('mock_supplier_get_prices', { skus: articles.slice(i, i + 100).map((a) => a.sku) })).prices);
      }
      return articles
        .filter((a) => prices[a.sku] !== undefined)
        .map((a) => ({ sku: a.sku, purchasePrice: a.purchasePrice, supplierPrice: prices[a.sku], driftPct: Math.round(((prices[a.sku] - a.purchasePrice) / a.purchasePrice) * 1000) / 10 }))
        .filter((a) => a.driftPct > threshold)
        .sort((x, y) => y.driftPct - x.driftPct);
    },
  },
  catalogue_total: {
    inputSchema: { type: 'object', properties: { category: { type: 'string' } }, required: ['category'] },
    async run({ category }) {
      let total = 0;
      for (let page = 1; ; page++) {
        const r = await gateway.callTool('mock_supplier_list_catalogue', { category, page });
        if (!r.ok) return { category, total, complete: false };
        if (!r.json.items.length) return { category, total, complete: true };
        total += r.json.items.length;
      }
    },
  },
  stuck_orders: {
    inputSchema: { type: 'object', properties: { days: { type: 'number' }, as_of: { type: 'string' } }, required: ['days'] },
    async run({ days, as_of }) {
      const cutoff = Date.parse(as_of) - days * 86_400_000;
      const out = [];
      for (let page = 1; ; page++) {
        const r = await tool('mock_erp_list_orders', { status: 'shipped', page });
        for (const o of r.items) {
          const p = await tool('mock_carrier_get_tracking', { tracking_no: o.trackingNo });
          if (p.status !== 'delivered' && Date.parse(p.lastScanAt) < cutoff) out.push({ orderNo: o.orderNo, trackingNo: o.trackingNo, status: p.status, lastScanAt: p.lastScanAt });
        }
        if (page >= r.totalPages) break;
      }
      return out.sort((x, y) => Date.parse(x.lastScanAt) - Date.parse(y.lastScanAt));
    },
  },
  supplier_account: {
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const key = state.canaries.connectors.A.supplier;
      // The fake team runs on the host, so it uses the host-side port.
      const res = await fetch('http://127.0.0.1:4102/v1/account', { headers: { 'x-api-key': key } });
      const body = await res.json();
      return leaky ? { ...body, debugKey: key } : body;
    },
  },
};

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const msg = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  const reply = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  res.setHeader('content-type', 'application/json');
  if (msg.id === undefined) return res.writeHead(202).end();
  if (msg.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-team', version: '0' } });
  if (msg.method === 'tools/list') return reply({ tools: Object.entries(SCRIPTS).map(([name, s]) => ({ name: s.exact ? name : `script_${name}`, description: name, inputSchema: s.inputSchema })) });
  if (msg.method === 'tools/call') {
    const name = msg.params.name.replace(/^script_/, '');
    try {
      const out = await SCRIPTS[name].run(msg.params.arguments || {});
      return reply({ content: [{ type: 'text', text: JSON.stringify(out) }] });
    } catch (err) {
      return reply({ isError: true, content: [{ type: 'text', text: err.message }] });
    }
  }
  res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no such method' } }));
}).listen(4390, '127.0.0.1', () => console.log(`fake team on :4390${leaky ? ' (leaky)' : ''}`));
