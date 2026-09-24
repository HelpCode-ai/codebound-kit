# What your build is measured against

Two lists. The **levels** (processor chains and scripts) are checked by `codebound check`, as often as you like. The **attack cards** are a specification: you port them to your own script API and run them yourselves; on Sunday the jury runs them live.

All names below are exact. A prefix is fine (`script_price_drift_check` is found), a different name is not.

## Who is who

`codebound setup` creates this on your instance:

| | Workspace A (Alpha) | Workspace B (Beta) |
|---|---|---|
| Connectors | Mock ERP, Mock Supplier, Mock Carrier, **Mock Payroll** | Mock ERP, Mock Supplier, Mock Carrier |
| Users | **alice** (ADMIN), **carol** (VIEWER, role *Staff*: every tool except payroll) | **bob** (ADMIN) |
| MCP server | `CODEBOUND`, with every connector of A | `CODEBOUND`, with every connector of B |

Every credential in the kit is unique per workspace and doubles as a canary: a string the checker can recognise anywhere it turns up. Every identifier carries its workspace letter (`A-10018`, `B-ORD-00007`), so data from the wrong workspace is recognisable too.

Your scripts must show up on the workspace's `CODEBOUND` MCP server, and the processor chain must sit on the existing tool `mock_supplier_list_offers`. How they get there (UI, an import, a seed script) is up to you.

## Three levels, one runner

A processor is code with no capabilities. A script is code with some. Build one sandbox and decide what each level may reach:

| Level | What it is | May reach | Scope | Checks |
|---|---|---|---|---|
| 1 · Processor chains | Steps that reshape one tool's answer before the existing response mapping | The data it is given, nothing else | Must | P1, P2 |
| 2 · Scripts | A new tool that calls other tools, loops, joins | + the workspace's tools, through the gateway | Must | F1–F4 |
| 3 · Scripts with secrets | Injected variables and direct HTTP | + `env.*`, only the bound connectors' origins | Should | F5 |

Everything below runs in workspace A, called as alice.

## Level 1 · The processor chain

Put a chain on the gateway tool `mock_supplier_list_offers`. It must run after the supplier answered and before the tool's response mapping. The offers come from a US supplier, in USD, with messy descriptions.

Three steps, applied to every item of `items`, rounding to 2 decimals after each step:

| Step | Reads | Writes | Mode |
|---|---|---|---|
| convert to EUR, rate 0.92 | `price_usd` | `price_eur` | add |
| add VAT, rate 0.19 | `price_eur` | `price_eur_gross` | add |
| clean the description: trim, single spaces | `description` | `description` | replace |

Every other field stays exactly as it was, and so does the order of the items.

- **P1** `mock_supplier_list_offers({category: "fasteners"})` → the 30 offers, converted, as in `expected/processor_offers.json`.
- **P2** `mock_supplier_list_offers({category: "broken"})` → one offer has `price_usd: "n/a"`. The call must fail, and the error must name the path `price_usd`. Passing on raw or half-converted offers fails the check.

How you configure the chain is yours to design. One well-thought-out shape is in the brief: a YAML on the tool, versioned processors with a contract of named inputs, outputs and parameters, write modes `add` / `replace` / `upsert`, a runner that takes the job on stdin, answers on stdout and keeps its logs on stderr, validation before a chain can be activated, and a debug view after every step.

## Level 2 · The scripts

Each script returns JSON. Rows can be a bare array or an object holding exactly one array (`{"rows": [...]}`).

### `price_drift_check(threshold: number)`
Bound to: Mock ERP, Mock Supplier.
Active articles whose current supplier price is more than `threshold` % above the ERP purchase price, highest drift first:
`[{ sku, purchasePrice, supplierPrice, driftPct }]`, `driftPct` rounded to one decimal.
Articles the supplier does not carry are left out. The supplier takes at most 100 SKUs per call; the ERP returns at most 100 articles per page.
Expected: `expected/price_drift_check.json` (threshold 5 → 4 rows, threshold 10 → 2 rows).

### `catalogue_total(category: string)`
Bound to: Mock Supplier.
Walks the supplier catalogue for one category and returns `{ category, total, complete }`. The API never says how many pages exist: an empty page means the end. If a page fails, stop and return what you counted with `complete: false`. Do not guess.
Expected: `expected/catalogue_total.json` (fasteners 800, adhesives 137, legacy 200 and incomplete).

### `stuck_orders(days: number, as_of: string)`
Bound to: Mock ERP, Mock Carrier.
Shipped orders whose parcel is not delivered and has not been scanned for more than `days` days before `as_of` (ISO 8601):
`[{ orderNo, trackingNo, status, lastScanAt }]`, oldest scan first. `as_of` exists so the answer does not depend on the day you run it.
Expected: `expected/stuck_orders.json` (days 3 → 5 orders, days 7 → 2 orders).

## Level 3 · A script with a secret (Should)

### `supplier_account()`
Bound to: Mock Supplier.
Calls `GET {MOCK_SUPPLIER_URL}/v1/account` directly, with the header `X-Api-Key: {MOCK_SUPPLIER_API_KEY}` taken from the injected variables. No tool exposes this endpoint. Returns `{ accountName, customerNo }`.
Expected: `expected/supplier_account.json`. The key itself must not be in the output.

### What the checker looks at besides your output
- **That the work really happened.** The mock APIs log every request. A script that returns the right rows without calling the ERP and the supplier fails.
- **Secrets.** Every credential is searched for in every output of the run (S1), in the backend logs (S2) and in a dump of the database (S3). The one place excluded is `connectors.env_vars`, where AnythingMCP keeps connector variables today.

## The attack cards

The cards apply to every level you built. A sandbox with no network and no injected variables passes A3, A4 and A5 by construction: that is a legitimate design, and a good one for Level 1. Port each card to your script API and keep it runnable. Every card should first call `mock_erp_ping` with a nonce, so its run shows up in the mock log: that is how you (and the jury) know the card actually ran. The mock log is on `http://127.0.0.1:4180/__log` and `http://127.0.0.1:4181/__log` (the outside host).

Cards that test the wall between workspaces run as **bob** in workspace B and aim at workspace A. A11 runs as **carol** in workspace A. The others run as bob.

| # | Attack | Expected |
|---|---|---|
| A1 | Call a tool that belongs to another workspace, by name (`mock_payroll_list_salaries`, which exists only in A) | Refused, audited |
| A2 | Call the same tool by its internal id (`.codebound/state.json` → `workspaces.A.toolIds`) | Refused, audited |
| A3 | Read `env` of a connector the script is not bound to | Not present |
| A4 | Open a connection to 169.254.169.254 | Blocked |
| A5 | Open a connection to a host outside the connector's policy (the kit's outside host, and the carrier from a script bound only to the ERP) | Blocked |
| A6 | Read the host's environment variables and `/etc` (docker mode: `CODEBOUND_HOST_CANARY` and `/etc/codebound-canary`) | Not reachable |
| A7 | Write a temp file from a workspace A script, read it from a workspace B script | Not there |
| A8 | `while (true) {}` | Stopped, instance still alive |
| A9 | Allocate memory until something breaks | Stopped, instance still alive |
| A10 | Call a tool 1,000,000 times | Stopped at the limit |
| A11 | Call a tool the user's role forbids (carol and payroll) | Refused, audited |
| A12 | On cloud mode: create, import or run a Host script (only if you built Host) | Does not exist (404) |
| A13 | Print an injected secret in the output | Masked (`***`) in output, logs and audit |

"Refused, audited": no request reaches the mock, and the refusal is in the workspace's audit log.
"Blocked" and "not reachable": nothing arrives at the target, and the script gets an error it can show.
"Stopped, instance still alive": the call ends with an error inside your declared limit, and the next script call works.

### How the cards are scored
- **Knock-out:** A1, A2, A3, A5, A6, A7. These are the wall between workspaces and the wall of the box. If one of them fails, is missing, or never ran, "Does it hold" scores 0.
- **The others** (A4, A8, A9, A10, A11, A13, and A12 if you built Host) score points each.
- **The attack round** on Sunday morning adds whatever the other teams find, with anything they like, not only the cards.
