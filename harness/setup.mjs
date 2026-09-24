// `codebound setup`: turns a fresh AnythingMCP instance into the two-workspace
// test bed every team gets, and proves it works before any team code is
// involved. Idempotent enough to re-run after a failure on the same database.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AnythingMcp, MockAdmin, ApiError } from './api.mjs';
import { McpClient } from './mcp.mjs';
import { CONNECTORS, WORKSPACE_CONNECTORS, importBundle } from '../connectors/connectors.mjs';
import { STATE_DIR, saveState, randomHex, nonce, canary } from './state.mjs';

const MOCKS_ADMIN = process.env.CODEBOUND_MOCKS_ADMIN || 'http://127.0.0.1:4180';
const OUTSIDE_ADMIN = process.env.CODEBOUND_OUTSIDE_ADMIN || 'http://127.0.0.1:4181';

const WORKSPACE_NAMES = { A: 'Alpha (CODEBOUND workspace A)', B: 'Beta (CODEBOUND workspace B)' };

const say = (msg) => console.log(`  ${msg}`);
const step = (msg) => console.log(`\n▸ ${msg}`);

function mockUrls(mode, outsideIp) {
  if (mode === 'docker') {
    return {
      erp: 'http://codebound-erp:4101',
      supplier: 'http://codebound-supplier:4102',
      carrier: 'http://codebound-carrier:4103',
      payroll: 'http://codebound-payroll:4104',
      outsideByName: 'http://codebound-outside:4199',
      outsideByIp: outsideIp ? `http://${outsideIp}:4199` : null,
    };
  }
  return {
    erp: 'http://localhost:4101',
    supplier: 'http://localhost:4102',
    carrier: 'http://localhost:4103',
    payroll: 'http://localhost:4104',
    outsideByName: 'http://localhost:4199',
    outsideByIp: 'http://127.0.0.1:4199',
  };
}

async function findOrCreateUserViaInvite(adminInOrg, anon, { email, password, name, role, mcpRoleIds }) {
  const users = await adminInOrg.get('/api/users');
  const list = Array.isArray(users) ? users : users?.items || users?.data || [];
  if (list.some((u) => u.email === email)) return anon.login(email, password);
  const invite = await adminInOrg.post('/api/auth/invite', { email, role, ...(mcpRoleIds ? { mcpRoleIds } : {}) });
  const token = new URL(invite.inviteUrl).searchParams.get('token');
  const accepted = await anon.post('/api/auth/accept-invite', { token, password, name });
  return accepted?.accessToken ? anon.withToken(accepted.accessToken) : anon.login(email, password);
}

async function setUpWorkspace(api, ws, urls, creds) {
  // Connectors, imported once, then given this workspace's variables and auth.
  const existing = await api.connectors();
  const wanted = WORKSPACE_CONNECTORS[ws];
  const missing = wanted.filter((k) => !existing.some((c) => c.name === CONNECTORS[k].name));
  if (missing.length) {
    const r = await api.post('/api/connectors/import-all', importBundle(missing));
    if (r?.errors?.length) throw new Error(`import-all in ${ws}: ${r.errors.join('; ')}`);
  }
  const connectors = await api.connectors();
  const ids = {};
  const tools = {};
  for (const k of wanted) {
    const c = connectors.find((x) => x.name === CONNECTORS[k].name);
    if (!c) throw new Error(`connector ${CONNECTORS[k].name} missing in workspace ${ws} after import`);
    ids[k] = c.id;
    const [urlVar, secretVar] = CONNECTORS[k].envVarNames;
    await api.put(`/api/connectors/${c.id}/env-vars`, { envVars: { [urlVar]: urls[k], [secretVar]: creds[k] } });
    await api.put(`/api/connectors/${c.id}`, { authType: CONNECTORS[k].authType, authConfig: CONNECTORS[k].authConfig });
    for (const t of await api.connectorTools(c.id)) tools[t.name] = t.id;
  }

  // One MCP server per workspace with every connector on it.
  const servers = await api.get('/api/mcp-servers?limit=100');
  const list = Array.isArray(servers) ? servers : servers?.items || servers?.data || [];
  let server = list.find((s) => s.slug === 'codebound');
  if (!server) server = await api.post('/api/mcp-servers', { name: 'CODEBOUND', slug: 'codebound', description: 'Hackathon test bed. Your scripts must show up on this server.' });
  await api.put(`/api/mcp-servers/${server.id}/connectors`, { connectorIds: Object.values(ids) });
  return { connectorIds: ids, toolIds: tools, serverId: server.id };
}

async function ensureRole(api, name, description) {
  const roles = await api.get('/api/roles');
  const list = Array.isArray(roles) ? roles : roles?.items || [];
  return list.find((r) => r.name === name) || api.post('/api/roles', { name, description });
}

async function newKey(api, label, serverId) {
  const r = await api.post('/api/mcp-keys', { name: label, mcpServerId: serverId });
  const key = r.key || r.apiKey || r.token;
  if (!key) throw new Error(`POST /api/mcp-keys returned no key: ${JSON.stringify(r).slice(0, 200)}`);
  return key;
}

async function expectLog(admin, sinceSeq, predicate, what) {
  for (let i = 0; i < 10; i++) {
    const entries = await admin.entriesSince(sinceSeq);
    if (entries.some(predicate)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`baseline check failed: ${what}`);
}

export async function setup(opts) {
  const mode = opts.mode || 'host';
  if (!['host', 'docker'].includes(mode)) throw new Error('--mode must be host (backend via npm run dev) or docker');
  const anon = new AnythingMcp(opts.url);
  const mocks = new MockAdmin(MOCKS_ADMIN);
  const outside = new MockAdmin(OUTSIDE_ADMIN);

  step('Preflight');
  await anon.health().catch((e) => { throw new Error(`AnythingMCP not reachable at ${opts.url}: ${e.message}`); });
  say(`AnythingMCP ${opts.url} is up`);
  await mocks.health().catch(() => { throw new Error(`mock APIs not reachable at ${MOCKS_ADMIN}. Start them: docker compose -f compose/mocks.yml up -d --build`); });
  await outside.health().catch(() => { throw new Error(`outside host not reachable at ${OUTSIDE_ADMIN}`); });
  say('mock APIs and outside host are up');
  const outsideIp = mode === 'docker' ? (await outside.whoami()).addresses[0] : null;
  const urls = mockUrls(mode, outsideIp);

  const passwords = {
    alice: opts.adminPassword || `Cb-${randomHex(8)}-A!`,
    bob: `Cb-${randomHex(8)}-B!`,
    carol: `Cb-${randomHex(8)}-C!`,
  };
  const emails = {
    alice: opts.adminEmail || 'alice@alpha.codebound.test',
    bob: 'bob@beta.codebound.test',
    carol: 'carol@alpha.codebound.test',
  };

  step('Credentials (canaries)');
  const creds = {
    A: { erp: canary('erp', 'A'), supplier: canary('supplier', 'A'), carrier: canary('carrier', 'A'), payroll: canary('payroll', 'A') },
    B: { erp: canary('erp', 'B'), supplier: canary('supplier', 'B'), carrier: canary('carrier', 'B') },
  };
  await mocks.setTenants(creds);
  say('registered 7 credentials with the mock APIs; each one is also a canary the checker looks for');

  step('Workspace A (Alpha) and its admin, alice');
  let alice;
  try {
    ({ api: alice } = await anon.register(emails.alice, passwords.alice, 'Alice (Alpha admin)'));
    say(`registered ${emails.alice} as the first admin`);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    if (!opts.adminPassword) {
      throw new Error(`this instance already has users. Either start from an empty database, or pass the first admin's credentials: --admin-email <email> --admin-password <password>`);
    }
    alice = await anon.login(emails.alice, passwords.alice);
    say(`logged in as existing admin ${emails.alice}`);
  }
  // A re-run after a failure may find alice still switched into B. Workspace A
  // is the one named for it, or on a first run her own workspace.
  const mineAtStart = await alice.get('/api/organizations/mine');
  const orgsAtStart = (Array.isArray(mineAtStart) ? mineAtStart : mineAtStart?.items || []).map((m) => m.organization || m);
  const namedA = orgsAtStart.find((o) => o.name === WORKSPACE_NAMES.A);
  if (namedA) alice = await alice.switchOrg(namedA.id);
  const orgA = await alice.get('/api/organizations/current');
  if (orgA.name === WORKSPACE_NAMES.B) throw new Error('alice is in workspace B and no workspace A exists; start from an empty database');
  await alice.put('/api/organizations/current', { name: WORKSPACE_NAMES.A });
  const wsA = await setUpWorkspace(alice, 'A', urls, creds.A);
  say(`4 connectors, MCP server ${wsA.serverId}`);

  step('Roles in A: payroll is HR-only, carol is Staff');
  const hr = await ensureRole(alice, 'HR', 'May read payroll.');
  const staff = await ensureRole(alice, 'Staff', 'Everything except payroll.');
  const payrollToolIds = Object.entries(wsA.toolIds).filter(([n]) => n.startsWith('mock_payroll_')).map(([, id]) => id);
  const staffToolIds = Object.entries(wsA.toolIds).filter(([n]) => !n.startsWith('mock_payroll_')).map(([, id]) => id);
  await alice.put(`/api/roles/${hr.id}/tools`, { toolIds: payrollToolIds });
  await alice.put(`/api/roles/${staff.id}/tools`, { toolIds: staffToolIds });
  const carol = await findOrCreateUserViaInvite(alice, anon, { email: emails.carol, password: passwords.carol, name: 'Carol (Alpha staff)', role: 'VIEWER', mcpRoleIds: [staff.id] });
  const carolMe = await carol.get('/api/users/me');
  await alice.put(`/api/roles/assignments/${carolMe.id}`, { roleIds: [staff.id] });
  say(`carol is a VIEWER in A with role Staff (${staffToolIds.length} tools, no payroll)`);

  step('Workspace B (Beta) and its admin, bob');
  const mine = await alice.get('/api/organizations/mine');
  const mineList = Array.isArray(mine) ? mine : mine?.items || [];
  let orgB = mineList.map((m) => m.organization || m).find((o) => o.name === WORKSPACE_NAMES.B);
  if (!orgB) orgB = await alice.post('/api/organizations', { name: WORKSPACE_NAMES.B });
  const aliceInB = await alice.switchOrg(orgB.id);
  const bobRaw = await findOrCreateUserViaInvite(aliceInB, anon, { email: emails.bob, password: passwords.bob, name: 'Bob (Beta admin)', role: 'ADMIN' });
  const bob = await bobRaw.switchOrg(orgB.id);
  const wsB = await setUpWorkspace(bob, 'B', urls, creds.B);
  say(`3 connectors (no payroll), MCP server ${wsB.serverId}`);
  // alice keeps working in A from here on.
  alice = await alice.switchOrg(orgA.id);

  step('MCP keys');
  const keys = {
    alice: await newKey(alice, `codebound-alice-${randomHex(3)}`, wsA.serverId),
    carol: await newKey(carol, `codebound-carol-${randomHex(3)}`, wsA.serverId),
    bob: await newKey(bob, `codebound-bob-${randomHex(3)}`, wsB.serverId),
  };
  say('one key per user, each scoped to its workspace\'s CODEBOUND server');

  step('Baseline: the unmodified gateway already behaves');
  const mcp = (who, ws) => new McpClient(`${opts.url.replace(/\/$/, '')}/mcp/${ws.serverId}`, keys[who]);
  for (const [who, ws, tenant] of [['alice', wsA, 'A'], ['bob', wsB, 'B'], ['carol', wsA, 'A']]) {
    const n = nonce(`setup-${who}`);
    const seq = await mocks.seq();
    const r = await mcp(who, ws).callTool('mock_erp_ping', { nonce: n });
    if (!r.ok) {
      const hint = /ssrf|private|blocked|not allowed|localhost/i.test(r.text)
        ? mode === 'host'
          ? '\n  The backend refused a private address. Start it with SSRF_ALLOWED_HOSTS=localhost (e.g. in packages/backend/.env) and run setup again.'
          : '\n  The backend refused the mock hosts. Did you start it with compose/anythingmcp.override.yml?'
        : '';
      throw new Error(`baseline: ${who} could not call mock_erp_ping: ${r.text.slice(0, 300)}${hint}`);
    }
    await expectLog(mocks, seq, (e) => e.service === 'erp' && e.query.nonce === n && e.tenant === tenant, `${who}'s ping did not reach the ERP as workspace ${tenant}`);
    say(`${who} → mock_erp_ping reached the ERP as workspace ${tenant}`);
  }
  {
    const seq = await mocks.seq();
    const r = await mcp('alice', wsA).callTool('mock_payroll_list_salaries', {});
    if (!r.ok) throw new Error(`baseline: alice (ADMIN) could not read payroll: ${r.text.slice(0, 300)}`);
    await expectLog(mocks, seq, (e) => e.service === 'payroll' && e.tenant === 'A', 'alice\'s payroll call did not reach Payroll');
    say('alice → payroll: allowed (ADMIN)');
  }
  {
    const seq = await mocks.seq();
    const r = await mcp('carol', wsA).callTool('mock_payroll_list_salaries', {});
    const hits = (await mocks.entriesSince(seq)).filter((e) => e.service === 'payroll');
    if (r.ok || hits.length) throw new Error('baseline: carol (Staff) was able to read payroll. Role setup did not take effect.');
    say('carol → payroll: refused (Staff)');
  }
  {
    const r = await mcp('bob', wsB).callTool('mock_payroll_list_salaries', {});
    if (r.ok) throw new Error('baseline: bob in workspace B could call workspace A\'s payroll tool on an unmodified gateway.');
    say('bob → payroll: not found (other workspace)');
  }

  // Host canaries. In docker mode they come from compose/anythingmcp.override.yml;
  // in host mode the backend has to be started with the env var set.
  let hostEnv = null;
  let hostFile = null;
  let hostFilePath = null;
  if (mode === 'docker') {
    const container = opts.appContainer || 'amcp-app';
    try {
      hostEnv = execFileSync('docker', ['exec', container, 'printenv', 'CODEBOUND_HOST_CANARY'], { encoding: 'utf8' }).trim();
      hostFile = execFileSync('docker', ['exec', container, 'cat', '/etc/codebound-canary'], { encoding: 'utf8' }).trim();
      hostFilePath = '/etc/codebound-canary';
    } catch {
      say(`! could not read the host canaries from container ${container} (pass --app-container). Card A6 will be skipped.`);
    }
  } else {
    hostEnv = process.env.CODEBOUND_HOST_CANARY || null;
    hostFilePath = path.join(STATE_DIR, 'host-secret.txt');
    hostFile = `cbk_hostfile_x_${randomHex(12)}`;
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(hostFilePath, `${hostFile}\n`);
  }

  const state = {
    version: 1,
    createdAt: new Date().toISOString(),
    url: opts.url.replace(/\/$/, ''),
    mode,
    appContainer: opts.appContainer || (mode === 'docker' ? 'amcp-app' : null),
    mockUrls: urls,
    users: {
      alice: { email: emails.alice, password: passwords.alice, workspace: 'A', role: 'ADMIN', key: keys.alice },
      carol: { email: emails.carol, password: passwords.carol, workspace: 'A', role: 'VIEWER + Staff', key: keys.carol },
      bob: { email: emails.bob, password: passwords.bob, workspace: 'B', role: 'ADMIN', key: keys.bob },
    },
    workspaces: {
      A: { name: WORKSPACE_NAMES.A, organizationId: orgA.id, ...wsA, roles: { hr: hr.id, staff: staff.id } },
      B: { name: WORKSPACE_NAMES.B, organizationId: orgB.id, ...wsB },
    },
    canaries: { connectors: creds, hostEnv, hostFile, hostFilePath },
  };
  saveState(state);

  step('Done');
  say(`State written to ${path.relative(process.cwd(), path.join(STATE_DIR, 'state.json'))} (contains passwords and keys; it is gitignored).`);
  say('');
  say('Sign in to the UI as any of:');
  for (const [who, u] of Object.entries(state.users)) say(`  ${who.padEnd(6)} ${u.email.padEnd(30)} ${u.password}   (${u.role}, workspace ${u.workspace})`);
  say('');
  say(`MCP endpoints:  A ${state.url}/mcp/${wsA.serverId}`);
  say(`                B ${state.url}/mcp/${wsB.serverId}`);
  if (mode === 'host' && !hostEnv) {
    say('');
    say('! Card A6 needs a canary in the backend\'s environment. Restart the backend with');
    say(`!   export CODEBOUND_HOST_CANARY=cbk_hostenv_x_${randomHex(12)}`);
    say('! and run setup again in the same shell, so the checker knows the value.');
  }
  say('');
  say('Next: build your scripts (see cards/CARDS.md), then run `node harness/cli.mjs check`.');
  return state;
}
