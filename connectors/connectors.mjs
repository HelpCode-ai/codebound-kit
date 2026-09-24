// The four mock connectors, in the shape AnythingMCP's
// POST /api/connectors/import-all accepts (the same shape export-all writes).
//
// Base URLs and credentials are {{VAR}} placeholders filled from each
// connector's environment variables at call time, which is exactly the
// mechanism a script's `env.*` is meant to reuse. `codebound setup` imports
// these, then sets the variables and the auth config per workspace.

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });

export const CONNECTORS = {
  erp: {
    name: 'Mock ERP',
    type: 'REST',
    baseUrl: '{{MOCK_ERP_URL}}',
    authType: 'BEARER_TOKEN',
    authConfig: { token: '{{MOCK_ERP_TOKEN}}' },
    headers: { Accept: 'application/json' },
    envVarNames: ['MOCK_ERP_URL', 'MOCK_ERP_TOKEN'],
    tools: [
      {
        name: 'mock_erp_list_articles',
        description: 'List articles from the ERP, 100 per page at most. The response carries totalItems and totalPages. Each article has sku, name, category, status (active or inactive), purchasePrice (EUR, what we last paid) and unit.',
        parameters: {
          type: 'object',
          properties: {
            status: str('Filter: active or inactive.'),
            category: str('Filter by category, e.g. fasteners.'),
            page: num('Page number, starting at 1.'),
            pageSize: num('Rows per page, 1-100 (default 100).'),
          },
        },
        endpointMapping: { method: 'GET', path: '/v1/articles', queryParams: { status: '$status', category: '$category', page: '$page', pageSize: '$pageSize' } },
      },
      {
        name: 'mock_erp_get_article',
        description: 'Get one ERP article by SKU.',
        parameters: { type: 'object', properties: { sku: str('The article SKU, e.g. A-10001.') }, required: ['sku'] },
        endpointMapping: { method: 'GET', path: '/v1/articles/{sku}' },
      },
      {
        name: 'mock_erp_list_orders',
        description: 'List customer orders, 50 per page at most. Shipped orders carry a trackingNo for the carrier.',
        parameters: {
          type: 'object',
          properties: {
            status: str('Filter: open or shipped.'),
            page: num('Page number, starting at 1.'),
            pageSize: num('Rows per page, 1-50 (default 50).'),
          },
        },
        endpointMapping: { method: 'GET', path: '/v1/orders', queryParams: { status: '$status', page: '$page', pageSize: '$pageSize' } },
      },
      {
        name: 'mock_erp_ping',
        description: 'Cheapest possible ERP call. Echoes the nonce back. The attack cards use it to prove a script really ran.',
        parameters: { type: 'object', properties: { nonce: str('Any string; it is echoed back.') } },
        endpointMapping: { method: 'GET', path: '/v1/ping', queryParams: { nonce: '$nonce' } },
      },
    ],
  },
  supplier: {
    name: 'Mock Supplier',
    type: 'REST',
    baseUrl: '{{MOCK_SUPPLIER_URL}}',
    authType: 'API_KEY',
    authConfig: { headerName: 'X-Api-Key', apiKey: '{{MOCK_SUPPLIER_API_KEY}}' },
    headers: { Accept: 'application/json' },
    envVarNames: ['MOCK_SUPPLIER_URL', 'MOCK_SUPPLIER_API_KEY'],
    tools: [
      {
        name: 'mock_supplier_get_prices',
        description: 'Current supplier prices (EUR) for up to 100 SKUs per call. SKUs the supplier does not carry come back in `unknown`.',
        parameters: {
          type: 'object',
          properties: { skus: { type: 'array', items: { type: 'string' }, description: 'Up to 100 SKUs.' } },
          required: ['skus'],
        },
        endpointMapping: { method: 'POST', path: '/v1/prices', bodyMapping: { skus: '$skus' } },
      },
      {
        name: 'mock_supplier_list_offers',
        description: 'Offers from the US supplier for a category: itemNo, description, price_usd, currency, moq. Categories: fasteners, broken.',
        parameters: {
          type: 'object',
          properties: { category: str('fasteners or broken.') },
          required: ['category'],
        },
        endpointMapping: { method: 'GET', path: '/v1/offers', queryParams: { category: '$category' } },
      },
      {
        name: 'mock_supplier_list_catalogue',
        description: 'One page (50 items) of the supplier catalogue for a category. The response does not say how many pages exist; an empty page means the end. Categories: fasteners, adhesives, legacy.',
        parameters: {
          type: 'object',
          properties: { category: str('fasteners, adhesives or legacy.'), page: num('Page number, starting at 1.') },
          required: ['category'],
        },
        endpointMapping: { method: 'GET', path: '/v1/catalogue', queryParams: { category: '$category', page: '$page' } },
      },
    ],
  },
  carrier: {
    name: 'Mock Carrier',
    type: 'REST',
    baseUrl: '{{MOCK_CARRIER_URL}}',
    authType: 'BEARER_TOKEN',
    authConfig: { token: '{{MOCK_CARRIER_TOKEN}}' },
    headers: { Accept: 'application/json' },
    envVarNames: ['MOCK_CARRIER_URL', 'MOCK_CARRIER_TOKEN'],
    tools: [
      {
        name: 'mock_carrier_get_tracking',
        description: 'Tracking status of one parcel: status (delivered, in_transit, exception), lastScanAt and lastScanLocation.',
        parameters: { type: 'object', properties: { tracking_no: str('Tracking number from the ERP order.') }, required: ['tracking_no'] },
        endpointMapping: { method: 'GET', path: '/v1/tracking/{tracking_no}' },
      },
    ],
  },
  payroll: {
    name: 'Mock Payroll',
    type: 'REST',
    baseUrl: '{{MOCK_PAYROLL_URL}}',
    authType: 'BEARER_TOKEN',
    authConfig: { token: '{{MOCK_PAYROLL_TOKEN}}' },
    headers: { Accept: 'application/json' },
    envVarNames: ['MOCK_PAYROLL_URL', 'MOCK_PAYROLL_TOKEN'],
    tools: [
      {
        name: 'mock_payroll_list_salaries',
        description: 'Every employee with monthly salary and IBAN. Sensitive: only the HR role may call it.',
        parameters: { type: 'object', properties: {} },
        endpointMapping: { method: 'GET', path: '/v1/employees' },
      },
    ],
  },
};

/** Which connectors each workspace gets. Payroll exists only in A. */
export const WORKSPACE_CONNECTORS = {
  A: ['erp', 'supplier', 'carrier', 'payroll'],
  B: ['erp', 'supplier', 'carrier'],
};

/** Body for POST /api/connectors/import-all. */
export function importBundle(keys) {
  return {
    connectors: keys.map((k) => {
      const { envVarNames, authConfig, ...c } = CONNECTORS[k];
      return {
        ...c,
        isActive: true,
        envVars: Object.fromEntries(envVarNames.map((n) => [n, ''])),
        tools: c.tools.map((t) => ({ ...t, isEnabled: true })),
      };
    }),
  };
}
