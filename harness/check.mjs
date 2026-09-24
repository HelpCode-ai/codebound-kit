// `codebound check`: runs the functional checks and the secret scans against
// the instance `codebound setup` prepared, and writes a report.

import fs from 'node:fs';
import { McpClient } from './mcp.mjs';
import { MockAdmin } from './api.mjs';
import { loadState, allCanaries } from './state.mjs';
import { CHECKS } from './checks.mjs';

const MOCKS_ADMIN = process.env.CODEBOUND_MOCKS_ADMIN || 'http://127.0.0.1:4180';

const ICON = { pass: '✔', fail: '✖', skip: '–', missing: '✖' };

function loadTeam(file, state) {
  const defaults = {
    callTimeoutSeconds: 120,
    logs: state.mode === 'docker' && state.appContainer ? { docker: state.appContainer } : null,
    postgres: {
      docker: state.mode === 'docker' && state.appContainer ? state.appContainer.replace(/-app$/, '-postgres') : 'amcp-postgres',
      user: 'amcp',
      db: 'anythingmcp',
    },
  };
  if (!fs.existsSync(file)) return defaults;
  const team = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { ...defaults, ...team, postgres: { ...defaults.postgres, ...(team.postgres || {}) } };
}

/** Exact name, or a name that ends in it after a separator (scripts may carry a prefix). */
function resolveTool(tools, name) {
  return tools.find((t) => t.name === name) || tools.find((t) => new RegExp(`[._/:-]${name}$`).test(t.name));
}

export async function check({ teamFile, only, cards, jsonFile }) {
  const state = loadState();
  const team = loadTeam(teamFile, state);
  const mocks = new MockAdmin(MOCKS_ADMIN);
  await mocks.health().catch(() => {
    throw new Error(`mock APIs not reachable at ${MOCKS_ADMIN}. Start them: docker compose -f compose/mocks.yml up -d`);
  });

  // CODEBOUND_MCP_URL_A points the checker elsewhere; the kit's own self-test uses it.
  const client = new McpClient(process.env.CODEBOUND_MCP_URL_A || `${state.url}/mcp/${state.workspaces.A.serverId}`, state.users.alice.key);
  let tools;
  try {
    tools = await client.listTools();
  } catch (err) {
    throw new Error(`cannot list tools on workspace A's MCP server: ${err.message}`);
  }

  const canaries = allCanaries(state);
  const ctx = {
    state,
    team,
    startedAt: new Date().toISOString(),
    outputs: [],
    current: null,
    tool: (name) => resolveTool(tools, name),
    leaks(text, except = []) {
      if (!text) return [];
      return canaries.filter((c) => !except.includes(c.value) && text.includes(c.value)).map((c) => c.label);
    },
    async call(name, args) {
      const tool = resolveTool(tools, name);
      const since = await mocks.seq();
      const r = await client.callTool(tool.name, args, { timeoutMs: team.callTimeoutSeconds * 1000 });
      r.log = await mocks.entriesSince(since);
      ctx.outputs.push({ label: `${ctx.current} ${tool.name}`, text: `${r.text}\n${r.raw}` });
      return r;
    },
  };

  let selected = CHECKS;
  if (only) selected = selected.filter((c) => ({ must: ['must'], should: ['should'], functional: ['must', 'should'], scan: ['scan'] })[only]?.includes(c.group));
  if (cards?.length) selected = selected.filter((c) => cards.map((x) => x.toUpperCase()).includes(c.id));
  // The output scan needs the functional outputs of this run.
  if (selected.some((c) => c.id === 'S1') && !selected.some((c) => c.group !== 'scan')) {
    console.log('  (S1 scans the outputs of this run, so the functional checks run too)');
    selected = CHECKS.filter((c) => c.group !== 'scan' || selected.includes(c));
  }

  console.log(`\nCODEBOUND check · ${state.url} · ${tools.length} tools on workspace A\n`);
  const results = [];
  for (const c of selected) {
    ctx.current = c.id;
    const missing = (c.tools || []).filter((t) => !resolveTool(tools, t));
    let res;
    if (missing.length) {
      res = { status: 'missing', details: [`no tool named ${missing.join(', ')} on workspace A's CODEBOUND server`] };
    } else {
      try {
        res = await c.run(ctx);
      } catch (err) {
        res = { status: 'fail', details: [`checker error: ${err.message}`] };
      }
    }
    results.push({ id: c.id, group: c.group, title: c.title, ...res });
    console.log(`${ICON[res.status] || '?'} ${c.id}  ${c.title}`);
    for (const d of res.details) console.log(`      ${d}`);
  }

  const count = (g) => {
    const rs = results.filter((r) => r.group === g);
    return `${rs.filter((r) => r.status === 'pass').length}/${rs.length}`;
  };
  const summary = { must: count('must'), should: count('should'), secretScans: count('scan') };
  console.log(`\nMust ${summary.must} · Should ${summary.should} · secret scans ${summary.secretScans}`);
  console.log('Attack cards: see cards/CARDS.md, run by you and live by the jury.\n');

  fs.writeFileSync(jsonFile, JSON.stringify({ at: new Date().toISOString(), url: state.url, summary, results }, null, 2));
  console.log(`Report written to ${jsonFile}`);
  return results.every((r) => r.status === 'pass' || r.status === 'skip') ? 0 : 1;
}
