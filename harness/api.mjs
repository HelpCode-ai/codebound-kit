// Thin clients for the AnythingMCP REST API and the mock admin ports.

export class ApiError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} -> HTTP ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`.slice(0, 600));
    this.status = status;
    this.body = body;
  }
}

async function request(base, method, path, opts = {}) {
  // AnythingMCP rate-limits login and a few auth routes to 5/minute. Setup
  // makes several of those calls, so wait out a 429 instead of failing.
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestOnce(base, method, path, opts);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 429 || attempt >= 4) throw err;
      console.log(`  (rate limited on ${path}, waiting 20 s)`);
      await new Promise((r) => setTimeout(r, 20_000));
    }
  }
}

async function requestOnce(base, method, path, { token, body, timeoutMs = 30_000 } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base.replace(/\/$/, '') + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) throw new ApiError(method, path, res.status, parsed);
  return parsed;
}

/** AnythingMCP backend, authenticated as one user in one workspace. */
export class AnythingMcp {
  constructor(baseUrl, token = null) {
    this.baseUrl = baseUrl;
    this.token = token;
  }
  withToken(token) {
    return new AnythingMcp(this.baseUrl, token);
  }
  get(path) {
    return request(this.baseUrl, 'GET', path, { token: this.token });
  }
  post(path, body) {
    return request(this.baseUrl, 'POST', path, { token: this.token, body: body ?? {} });
  }
  put(path, body) {
    return request(this.baseUrl, 'PUT', path, { token: this.token, body: body ?? {} });
  }
  async health() {
    return request(this.baseUrl, 'GET', '/health', { timeoutMs: 5000 });
  }
  async login(email, password) {
    const r = await request(this.baseUrl, 'POST', '/api/auth/login', { body: { email, password } });
    if (!r?.accessToken) throw new Error(`login for ${email} returned no access token (MFA enabled?): ${JSON.stringify(r).slice(0, 200)}`);
    return this.withToken(r.accessToken);
  }
  async register(email, password, name) {
    const r = await request(this.baseUrl, 'POST', '/api/auth/register', { body: { email, password, name, acceptTerms: true } });
    return { api: this.withToken(r.accessToken), user: r.user };
  }
  /** Returns a client whose JWT is scoped to `organizationId`. */
  async switchOrg(organizationId) {
    const r = await this.post('/api/organizations/switch', { organizationId });
    return this.withToken(r.accessToken);
  }
  /** Tools of a connector: [{ id, name, ... }]. */
  async connectorTools(connectorId) {
    const r = await this.get(`/api/connectors/${connectorId}/tools`);
    return Array.isArray(r) ? r : r?.items || r?.data || [];
  }
  async connectors() {
    const r = await this.get('/api/connectors?limit=100');
    return Array.isArray(r) ? r : r?.items || r?.data || [];
  }
}

/** Admin port of a mock container: request log and credentials. */
export class MockAdmin {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }
  health() {
    return request(this.baseUrl, 'GET', '/__health', { timeoutMs: 3000 });
  }
  seq() {
    return this.health().then((h) => h.seq);
  }
  async entriesSince(seq) {
    const r = await request(this.baseUrl, 'GET', `/__log?since=${seq}`);
    return r.entries;
  }
  setTenants(tenants) {
    return request(this.baseUrl, 'PUT', '/__tenants', { body: tenants });
  }
  whoami() {
    return request(this.baseUrl, 'GET', '/__whoami');
  }
}
