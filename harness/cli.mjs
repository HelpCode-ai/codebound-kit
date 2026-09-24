#!/usr/bin/env node
// codebound: setup and acceptance checks for the CODEBOUND challenge.
//
//   node harness/cli.mjs setup  --url http://localhost:4000 [--mode host|docker]
//   node harness/cli.mjs check  [--only must|should|scan] [--card P1]
//   node harness/cli.mjs cards  (prints what each check calls and expects)

import { parseArgs } from 'node:util';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string', default: 'http://localhost:4000' },
    mode: { type: 'string', default: 'host' },
    'admin-email': { type: 'string' },
    'admin-password': { type: 'string' },
    'app-container': { type: 'string' },
    team: { type: 'string', default: 'codebound.team.json' },
    only: { type: 'string' },
    card: { type: 'string', multiple: true },
    json: { type: 'string', default: 'codebound-report.json' },
    help: { type: 'boolean', short: 'h' },
  },
});

const cmd = positionals[0];

async function main() {
  if (!cmd || values.help) {
    console.log(`codebound — CODEBOUND hackathon kit

  setup   Prepare a fresh AnythingMCP instance: two workspaces, three users,
          the mock connectors, roles and MCP keys. Verifies the baseline.
            --url <backend>        default http://localhost:4000
            --mode host|docker     host = backend via \`npm run dev\` (default)
            --admin-email/--admin-password   if the instance already has an admin
            --app-container <name> docker mode, default amcp-app

  check   Run the acceptance checks against your build.
            --only must|should|scan
            --card P1 --card F2    run single checks
            --team <file>          default codebound.team.json
            --json <file>          report file, default codebound-report.json

  cards   Print every check with what it calls and what it expects.
          The attack cards are a specification: cards/CARDS.md.`);
    return;
  }
  if (cmd === 'setup') {
    const { setup } = await import('./setup.mjs');
    await setup({
      url: values.url,
      mode: values.mode,
      adminEmail: values['admin-email'],
      adminPassword: values['admin-password'],
      appContainer: values['app-container'],
    });
    return;
  }
  if (cmd === 'check') {
    const { check } = await import('./check.mjs');
    const code = await check({ teamFile: values.team, only: values.only, cards: values.card, jsonFile: values.json });
    process.exitCode = code;
    return;
  }
  if (cmd === 'cards') {
    const { printCards } = await import('./checks.mjs');
    printCards();
    return;
  }
  throw new Error(`unknown command "${cmd}"`);
}

main().catch((err) => {
  console.error(`\n✖ ${err.message}`);
  if (process.env.CODEBOUND_DEBUG) console.error(err.stack);
  process.exitCode = 2;
});
