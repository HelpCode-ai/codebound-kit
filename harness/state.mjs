import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const STATE_DIR = path.resolve(process.env.CODEBOUND_STATE_DIR || '.codebound');
export const STATE_FILE = path.join(STATE_DIR, 'state.json');

export function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    throw new Error(`No ${path.relative(process.cwd(), STATE_FILE)} here. Run \`node harness/cli.mjs setup\` first.`);
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

export function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');
export const nonce = (label) => `cb-${label}-${randomHex(6)}`;

/** A credential that is easy to grep for and impossible to confuse with anything else. */
export const canary = (service, workspace) => `cbk_${service}_${workspace.toLowerCase()}_${randomHex(12)}`;

export const CANARY_RE = /cbk_[a-z]+_[a-z]+_[0-9a-f]{12,}/g;

/** Every secret value the kit planted, with where it came from. */
export function allCanaries(state) {
  const list = [];
  for (const [ws, svcs] of Object.entries(state.canaries.connectors)) {
    for (const [svc, value] of Object.entries(svcs)) list.push({ value, label: `${ws}/${svc} credential` });
  }
  if (state.canaries.hostEnv) list.push({ value: state.canaries.hostEnv, label: 'host env CODEBOUND_HOST_CANARY' });
  if (state.canaries.hostFile) list.push({ value: state.canaries.hostFile, label: 'host file canary' });
  return list;
}
