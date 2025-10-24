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

const transport = new StdioServerTransport();
mcpServer.connect(transport).catch((err) => {
  console.error('MCP server failed to start', err);
  process.exit(1);
});
