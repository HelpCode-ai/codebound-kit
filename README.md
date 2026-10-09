# CODEBOUND kit

Test kit for **CODEBOUND: Safe Script Sandbox for AI Agents in AnythingMCP**, the AnythingMCP challenge at the Black Forest Hackathon 2026 (KOCH Freiburg GmbH, Offenburg, 16–18 October).

Today every intermediate result an AI agent works with travels back through the model. In production one tool call in eight returns more than 50 KB, the largest 44 MB, so multi-step jobs end up slow, expensive or done by hand. The way out is to let the agent send a small script to where the data lives and get the answer back instead of the raw data.

You are building code that runs next to the data, inside [AnythingMCP](https://github.com/HelpCode-ai/anythingmcp), in a sandbox that sees exactly one workspace and nothing else. Three levels: **processor chains** that reshape a tool's answer before the model sees it, **scripts** that call the workspace's tools and return four rows instead of four hundred, and **scripts with secrets** that make direct calls with injected credentials, to the hosts of the workspace's own connectors and nowhere else. This kit gives you something to build against and a way to know it works:

- **Four mock systems** (ERP, Supplier, Carrier, Payroll) with fixed data, plus one host no script may reach.
- **A setup command** that turns a fresh AnythingMCP into two workspaces, three users, roles and MCP keys, and proves the unmodified gateway behaves before you touch it.
- **Expected results** for the processor chain and the four reference scripts (`expected/`).
- **A checker** that calls your chain and your scripts over MCP, compares with the expected results, checks the mock log to see the work really happened, and searches outputs, logs and the database for leaked credentials.
- **The attack cards** (`cards/CARDS.md`), the specification you port to your own script API.

Node 20 or newer and Docker. No `npm install`: the kit has no dependencies.

## Start

```bash
# 1. The mock systems
npm run mocks

# 2. AnythingMCP, from your fork. Either the backend in Docker, built from
#    your code (--build; without it Docker runs the published image) and with
#    real secrets in .env (the backend refuses to start on the defaults):
printf 'JWT_SECRET=%s\nENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
docker compose -f docker-compose.yml -f <path-to-kit>/compose/anythingmcp.override.yml up -d --build
#    or the backend with hot reload (npm run dev), started with
#    SSRF_ALLOWED_HOSTS=localhost so it may call the mocks on localhost.

# 3. The test bed, on an EMPTY database
npm run setup -- --url http://localhost:4000 --mode docker   # or --mode host
```

Setup prints three logins for the UI (alice, carol, bob) and the two MCP endpoints, and writes everything to `.codebound/state.json` (gitignored: it holds passwords and keys).

```bash
# 4. Whenever you want to know where you stand
npm run check
npm run check -- --card P1        # one check
npm run check -- --only must       # the Must, nothing else
npm run cards                     # what each check calls and expects
```

Copy `codebound.team.example.json` to `codebound.team.json` and point it at your backend logs and your Postgres container, so the secret scans S2 and S3 can run. The jury run on Sunday needs both.

## What gets checked

| | Check | Level | |
|---|---|---|---|
| P1 | A processor chain on `mock_supplier_list_offers`: USD to EUR, VAT added, descriptions cleaned | 1 · Must | automatic |
| P2 | A broken input stops the chain with an error that names the path | 1 · Must | automatic |
| F1 | The three scripts are tools, with typed parameters | 2 · Must | automatic |
| F2 | `price_drift_check`: hundreds of records in, four rows out | 2 · Must | automatic |
| F3 | `catalogue_total`: every page walked, a failing source admitted | 2 · Must | automatic |
| F4 | `stuck_orders`: ERP orders joined with carrier tracking | 2 · Must | automatic |
| F5 | `supplier_account`: a direct call with the injected key, key not shown | 3 · Should | automatic |
| S1 | No credential in any script output | all | automatic |
| S2 | No credential in the backend logs | all | automatic |
| S3 | No credential stored in clear in the database | all | automatic |
| A1–A13 | The attack cards | all | you, then the jury, live |

The details, the exact contract of each script and the scoring rules for the cards are in [`cards/CARDS.md`](cards/CARDS.md).

## The mock systems

| System | From the backend in Docker | From the host | Auth |
|---|---|---|---|
| ERP | `http://codebound-erp:4101` | `http://localhost:4101` | `Authorization: Bearer {{MOCK_ERP_TOKEN}}` |
| Supplier | `http://codebound-supplier:4102` | `http://localhost:4102` | `X-Api-Key: {{MOCK_SUPPLIER_API_KEY}}` |
| Carrier | `http://codebound-carrier:4103` | `http://localhost:4103` | `Authorization: Bearer {{MOCK_CARRIER_TOKEN}}` |
| Payroll (A only) | `http://codebound-payroll:4104` | `http://localhost:4104` | `Authorization: Bearer {{MOCK_PAYROLL_TOKEN}}` |
| Outside (unreachable by design) | `http://codebound-outside:4199` | `http://localhost:4199` | none |

The same credential returns a different dataset per workspace. Request logs, for you and the checker: `http://127.0.0.1:4180/__log` (mocks) and `http://127.0.0.1:4181/__log` (outside). Both admin ports are bound to 127.0.0.1 only.

Endpoints: `mocks/server.mjs`. Data: `mocks/data.mjs`, generated from a fixed seed, so every team sees the same numbers.

## Starting over

The setup expects an empty database. To reset: `docker compose down -v` on the AnythingMCP stack, `npm run mocks:down && npm run mocks`, `rm -rf .codebound`, then setup again.

## Questions and problems

Something in the kit is broken or unclear: open an issue in this repository, with the command you ran and its output (remove the passwords and keys from `.codebound/` first). Questions about AnythingMCP itself, the challenge or your idea: ask the KOCH team on site.

## For the kit itself

`npm test` checks that `expected/` matches the reference answers. `test/fake-team.mjs` is a fake team used to test the checker: the chain and four scripts running in a plain Node process, no sandbox, not a model answer.

AGPL-3.0, like AnythingMCP.
