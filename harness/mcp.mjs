// Minimal MCP client over Streamable HTTP. Enough for initialize, tools/list
// and tools/call, with no SDK dependency so the kit runs on a bare Node 20.

const PROTOCOL_VERSION = '2025-06-18';

export class McpClient {
  constructor(url, apiKey, { label = '' } = {}) {
    this.url = url;
    this.apiKey = apiKey;
    this.label = label;
    this.sessionId = null;
    this.nextId = 1;
    this.initialized = false;
  }

  async #post(body, { timeoutMs = 30_000 } = {}) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    // AnythingMCP reads per-user keys (mcp_...) from X-API-Key; anything else
    // is treated as a bearer token.
    if (this.apiKey.startsWith('mcp_')) headers['x-api-key'] = this.apiKey;
    else headers.authorization = `Bearer ${this.apiKey}`;
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (this.initialized) headers['mcp-protocol-version'] = PROTOCOL_VERSION;
    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const text = await res.text();
    if (body.id === undefined) return { status: res.status };
    if (!res.ok) throw new McpHttpError(res.status, `HTTP ${res.status}: ${text.slice(0, 300)}`);
    const ctype = res.headers.get('content-type') || '';
    let message;
    if (ctype.includes('text/event-stream')) {
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.id === body.id) message = parsed;
        } catch {
          /* ignore keep-alives */
        }
      }
    } else {
      try {
        message = JSON.parse(text);
      } catch {
        throw new McpHttpError(res.status, `HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
    }
    if (!message) throw new McpHttpError(res.status, `HTTP ${res.status}: no JSON-RPC response in body`);
    if (message.error) throw new McpRpcError(message.error, res.status);
    return message.result;
  }

  async init() {
    if (this.initialized) return;
    await this.#post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'codebound-check', version: '1.0.0' } },
    });
    this.initialized = true;
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async listTools() {
    await this.init();
    const tools = [];
    let cursor;
    do {
      const r = await this.#post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/list', params: cursor ? { cursor } : {} });
      tools.push(...(r.tools || []));
      cursor = r.nextCursor;
    } while (cursor);
    return tools;
  }

  /**
   * Calls a tool and never throws: the attack cards need to see refusals and
   * timeouts as data, not as exceptions.
   */
  async callTool(name, args = {}, { timeoutMs = 60_000 } = {}) {
    const started = Date.now();
    try {
      await this.init();
      const result = await this.#post(
        { jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } },
        { timeoutMs },
      );
      const text = (result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      let json;
      if (result?.structuredContent !== undefined) json = result.structuredContent;
      else {
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
      }
      return { ok: !result?.isError, isError: !!result?.isError, text, json, raw: JSON.stringify(result), ms: Date.now() - started };
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      return {
        ok: false,
        isError: true,
        transportError: true,
        timedOut,
        text: err?.message || String(err),
        raw: JSON.stringify({ error: err?.message || String(err), rpc: err?.rpc }),
        ms: Date.now() - started,
      };
    }
  }
}

export class McpHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class McpRpcError extends Error {
  constructor(rpc, status) {
    super(`JSON-RPC ${rpc.code}: ${rpc.message}`);
    this.rpc = rpc;
    this.status = status;
  }
}
