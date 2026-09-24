// CODEBOUND mock APIs. Zero dependencies, Node 20+.
//
//   MODE=mocks   (default) ERP :4101, Supplier :4102, Carrier :4103, Payroll :4104, admin :4180
//   MODE=outside a host no script may reach: :4199, admin :4181
//
// Every request is written to an in-memory log that the checker reads through
// the admin port. That log is how the attack cards are judged: if a script in
// workspace B manages to make the gateway call Payroll with workspace A's
// credential, the request shows up here, whatever the script itself reports.

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { dataset, TENANT_IDS } from './data.mjs';
import { CATALOGUE_PAGE_SIZE } from './reference.mjs';

const MODE = process.env.MODE || 'mocks';
const DATA_DIR = process.env.DATA_DIR || '/tmp/codebound-mocks';
const TENANTS_FILE = path.join(DATA_DIR, 'tenants.json');
const LOG_LIMIT = 200_000;

// ── Credentials ──────────────────────────────────────────────────────────────
// { A: { erp, supplier, carrier, payroll }, B: {...} }, registered by
// `codebound setup`. Nothing answers with data until then.
let tenants = {};
try {
  tenants = JSON.parse(fs.readFileSync(TENANTS_FILE, 'utf8'));
} catch {
  /* first start */
}

function tenantFor(service, credential) {
  if (!credential) return null;
  for (const id of TENANT_IDS) {
    if (tenants[id]?.[service] && tenants[id][service] === credential) return id;
  }
  return undefined;
}

// ── Request log ──────────────────────────────────────────────────────────────
let seq = 0;
const log = [];
function record(entry) {
  entry.seq = ++seq;
  entry.ts = new Date().toISOString();
  log.push(entry);
  if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= 1_000_000) chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({ __invalid: raw.slice(0, 200) });
      }
    });
  });
}

const intParam = (v, def, min, max) => {
  const n = Number.parseInt(v ?? '', 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
};

// ── Services ─────────────────────────────────────────────────────────────────
const SERVICES = {
  erp: {
    port: 4101,
    credential: (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null,
    routes: [
      ['GET', /^\/v1\/articles$/, (ds, q) => {
        let items = ds.articles;
        if (q.get('status')) items = items.filter((a) => a.status === q.get('status'));
        if (q.get('category')) items = items.filter((a) => a.category === q.get('category'));
        const pageSize = intParam(q.get('pageSize'), 100, 1, 100);
        const page = intParam(q.get('page'), 1, 1, 10_000);
        return [200, {
          page,
          pageSize,
          totalItems: items.length,
          totalPages: Math.ceil(items.length / pageSize),
          items: items.slice((page - 1) * pageSize, page * pageSize),
        }];
      }],
      ['GET', /^\/v1\/articles\/([^/]+)$/, (ds, q, m) => {
        const a = ds.articles.find((x) => x.sku === decodeURIComponent(m[1]));
        return a ? [200, a] : [404, { error: 'article not found' }];
      }],
      ['GET', /^\/v1\/orders$/, (ds, q) => {
        let items = ds.orders;
        if (q.get('status')) items = items.filter((o) => o.status === q.get('status'));
        const pageSize = intParam(q.get('pageSize'), 50, 1, 50);
        const page = intParam(q.get('page'), 1, 1, 10_000);
        return [200, {
          page,
          pageSize,
          totalPages: Math.ceil(items.length / pageSize),
          items: items.slice((page - 1) * pageSize, page * pageSize),
        }];
      }],
      ['GET', /^\/v1\/ping$/, (ds, q) => [200, { ok: true, nonce: q.get('nonce') || null, workspace: ds.company }]],
    ],
  },
  supplier: {
    port: 4102,
    credential: (req) => req.headers['x-api-key'] || null,
    routes: [
      ['POST', /^\/v1\/prices$/, (ds, q, m, body) => {
        const skus = Array.isArray(body?.skus) ? body.skus : null;
        if (!skus) return [400, { error: 'body must be {"skus": [...]}' }];
        if (skus.length > 100) return [400, { error: `at most 100 skus per request, got ${skus.length}` }];
        const prices = {};
        const unknown = [];
        for (const s of skus) {
          if (ds.supplierPrices[s] !== undefined) prices[s] = ds.supplierPrices[s];
          else unknown.push(s);
        }
        return [200, { currency: 'EUR', prices, unknown }];
      }],
      // The catalogue never says how many pages there are. A script has to
      // walk until it gets an empty page, and notice when the source fails.
      ['GET', /^\/v1\/catalogue$/, (ds, q) => {
        const category = q.get('category') || '';
        const cat = ds.catalogue[category];
        if (!cat) return [404, { error: `unknown category "${category}"`, categories: Object.keys(ds.catalogue) }];
        const page = intParam(q.get('page'), 1, 1, 10_000);
        if (cat.failsFromPage && page >= cat.failsFromPage) return [503, { error: 'upstream timeout, try again later' }];
        return [200, { category, page, items: cat.items.slice((page - 1) * CATALOGUE_PAGE_SIZE, page * CATALOGUE_PAGE_SIZE) }];
      }],
      // Offers from a US supplier, prices in USD. Raw on purpose: converting,
      // adding VAT and cleaning the descriptions is the processor chain's job.
      ['GET', /^\/v1\/offers$/, (ds, q) => {
        const category = q.get('category') || '';
        const items = ds.offers[category];
        if (!items) return [404, { error: `unknown category "${category}"`, categories: Object.keys(ds.offers) }];
        return [200, { category, items }];
      }],
      // Deliberately NOT exposed as a tool in the connector. Reaching it needs
      // the injected MOCK_SUPPLIER_API_KEY and a direct call.
      ['GET', /^\/v1\/account$/, (ds) => [200, { accountName: ds.company, customerNo: ds.customerNo }]],
    ],
  },
  carrier: {
    port: 4103,
    credential: (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null,
    routes: [
      ['GET', /^\/v1\/tracking\/([^/]+)$/, (ds, q, m) => {
        const p = ds.parcels[decodeURIComponent(m[1])];
        return p ? [200, p] : [404, { error: 'unknown tracking number' }];
      }],
      ['GET', /^\/v1\/probe$/, (ds, q) => [200, { ok: true, nonce: q.get('nonce') || null }]],
    ],
  },
  payroll: {
    port: 4104,
    credential: (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null,
    routes: [['GET', /^\/v1\/employees$/, (ds) => [200, { employees: ds.employees }]]],
  },
};

function serviceHandler(name, svc) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : undefined;
    const entry = {
      service: name,
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      remote: req.socket.remoteAddress,
    };
    if (url.pathname === '/health') {
      return send(res, 200, { ok: true, service: name });
    }
    const credential = svc.credential(req);
    const tenant = tenantFor(name, credential);
    entry.auth = credential ? (tenant ? 'ok' : 'invalid') : 'missing';
    entry.tenant = tenant || null;
    if (!tenant) {
      entry.status = 401;
      record(entry);
      return send(res, 401, { error: credential ? 'invalid credential' : 'missing credential' });
    }
    const ds = dataset(tenant);
    for (const [method, re, fn] of svc.routes) {
      const m = url.pathname.match(re);
      if (m && req.method === method) {
        const [status, payload] = fn(ds, url.searchParams, m, body);
        entry.status = status;
        record(entry);
        return send(res, status, payload);
      }
    }
    entry.status = 404;
    record(entry);
    return send(res, 404, { error: `no route ${req.method} ${url.pathname}` });
  };
}

// ── Admin (loopback on the host, see compose/codebound.override.yml) ─────────
function adminHandler(extra = {}) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://admin');
    if (url.pathname === '/__health') return send(res, 200, { ok: true, mode: MODE, seq });
    if (url.pathname === '/__log' && req.method === 'GET') {
      const since = intParam(url.searchParams.get('since'), 0, 0, Number.MAX_SAFE_INTEGER);
      return send(res, 200, { seq, entries: log.filter((e) => e.seq > since) });
    }
    if (url.pathname === '/__whoami') {
      const addrs = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
      return send(res, 200, { mode: MODE, addresses: addrs });
    }
    if (extra[url.pathname]) return extra[url.pathname](req, res, url);
    return send(res, 404, { error: 'unknown admin route' });
  };
}

function listen(port, handler, label) {
  // A mock must never go down mid-run: that would read as a sandbox failure.
  const safe = async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[${MODE}] ${label}: ${err.stack || err}`);
      if (!res.headersSent) send(res, 500, { error: 'mock internal error' });
    }
  };
  http.createServer(safe).listen(port, '0.0.0.0', () => console.log(`[${MODE}] ${label} on :${port}`));
}

if (MODE === 'outside') {
  // Answers anything, remembers everything.
  listen(4199, async (req, res) => {
    const url = new URL(req.url, 'http://outside');
    if (url.pathname !== '/health') {
      record({ service: 'outside', method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), remote: req.socket.remoteAddress, status: 200 });
    }
    send(res, 200, { reached: 'outside', note: 'If a script got this response, it left its policy.' });
  }, 'outside');
  listen(4181, adminHandler(), 'admin');
} else {
  for (const [name, svc] of Object.entries(SERVICES)) listen(svc.port, serviceHandler(name, svc), name);
  listen(4180, adminHandler({
    '/__tenants': async (req, res) => {
      if (req.method === 'GET') {
        // Only says which tenants are configured, never the credentials.
        return send(res, 200, Object.fromEntries(Object.entries(tenants).map(([k, v]) => [k, Object.keys(v)])));
      }
      if (req.method !== 'PUT') return send(res, 405, { error: 'GET or PUT' });
      const body = await readBody(req);
      for (const id of Object.keys(body)) if (!TENANT_IDS.includes(id)) return send(res, 400, { error: `unknown tenant ${id}` });
      tenants = body;
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(TENANTS_FILE, JSON.stringify(tenants), { mode: 0o600 });
      return send(res, 200, { ok: true, tenants: Object.keys(tenants) });
    },
  }), 'admin');
}
