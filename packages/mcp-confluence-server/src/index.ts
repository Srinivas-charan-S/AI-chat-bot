import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fetch } from 'undici';

const ENV = z.object({
  CONFLUENCE_BASE_URL: z.string().url(),
  CONFLUENCE_EMAIL: z.string(),
  CONFLUENCE_API_TOKEN: z.string(),
}).parse(process.env);

const OPTIONAL = z.object({
  QUIP_API_TOKEN: z.string().optional(),
  AZURE_TENANT_ID: z.string().optional(),
  AZURE_CLIENT_ID: z.string().optional(),
  AZURE_CLIENT_SECRET: z.string().optional(),
}).parse(process.env);

function buildAuthHeader(email: string, apiToken: string) {
  const token = Buffer.from(`${email}:${apiToken}`).toString('base64');
  return `Basic ${token}`;
}

async function confluenceSearch(query: string) {
  const url = new URL('/wiki/rest/api/search', ENV.CONFLUENCE_BASE_URL);
  const sanitized = query.replace(/"/g, '');
  url.searchParams.set('cql', `text ~ "${sanitized}"`);
  url.searchParams.set('limit', '10');

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: buildAuthHeader(ENV.CONFLUENCE_EMAIL, ENV.CONFLUENCE_API_TOKEN),
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Confluence search failed ${res.status}: ${text}`);
  }
  return await res.json();
}

async function confluenceGetPageContent(pageId: string) {
  const url = new URL(`/wiki/rest/api/content/${pageId}`, ENV.CONFLUENCE_BASE_URL);
  url.searchParams.set('expand', 'body.storage,version,space');

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: buildAuthHeader(ENV.CONFLUENCE_EMAIL, ENV.CONFLUENCE_API_TOKEN),
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Confluence get page failed ${res.status}: ${text}`);
  }
  return await res.json();
}

function extractQuipThreadId(idOrUrl: string): string {
  try {
    const u = new URL(idOrUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || idOrUrl;
  } catch {
    return idOrUrl;
  }
}

async function quipGetThread(idOrUrl: string) {
  if (!OPTIONAL.QUIP_API_TOKEN) {
    throw new Error('QUIP_API_TOKEN is not set');
  }
  const threadId = extractQuipThreadId(idOrUrl);
  const url = `https://platform.quip.com/1/threads/${threadId}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${OPTIONAL.QUIP_API_TOKEN}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Quip get thread failed ${res.status}: ${text}`);
  }
  return await res.json();
}

async function getGraphAccessToken() {
  const { AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET } = OPTIONAL;
  if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET) {
    throw new Error('Azure Graph credentials are not set');
  }
  const tokenUrl = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: AZURE_CLIENT_ID,
    client_secret: AZURE_CLIENT_SECRET,
    grant_type: 'client_credentials',
    scope: 'https://graph.microsoft.com/.default',
  });
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Azure token fetch failed ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error('Azure token response missing access_token');
  }
  return json.access_token;
}

async function sharepointSearch(query: string) {
  const accessToken = await getGraphAccessToken();
  const res = await fetch('https://graph.microsoft.com/v1.0/search/query', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [
        {
          entityTypes: ['driveItem', 'listItem', 'site'],
          query: { queryString: query },
          from: 0,
          size: 5,
        },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SharePoint search failed ${res.status}: ${text}`);
  }
  return await res.json();
}
const mcpServer = new McpServer({ name: 'confluence-mcp', version: '0.1.0' });

mcpServer.tool('confluence.search', {
  query: z.string().describe('Free text to search via CQL text ~'),
}, async ({ query }) => {
  const data = await confluenceSearch(query);
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
});

mcpServer.tool('confluence.getPage', {
  id: z.string().describe('Confluence page id'),
}, async ({ id }) => {
  const data = await confluenceGetPageContent(id);
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
});

mcpServer.tool('quip.getThread', {
  idOrUrl: z.string().describe('Quip thread id or full URL'),
}, async ({ idOrUrl }) => {
  try {
    const data = await quipGetThread(idOrUrl);
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  } catch (err: any) {
    return { content: [{ type: 'text', text: err?.message || String(err) }], isError: true };
  }
});

mcpServer.tool('sharepoint.search', {
  query: z.string().describe('Text to search across SharePoint via Microsoft Graph'),
}, async ({ query }) => {
  try {
    const data = await sharepointSearch(query);
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  } catch (err: any) {
    return { content: [{ type: 'text', text: err?.message || String(err) }], isError: true };
  }
});

const transport = new StdioServerTransport();
mcpServer.connect(transport).catch((err) => {
  console.error('MCP server failed to start', err);
  process.exit(1);
});
