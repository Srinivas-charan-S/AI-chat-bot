import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { request } from 'undici';

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
  url.searchParams.set('cql', `text ~ "${query.replace(/\"/g, '"')}"`);
  url.searchParams.set('limit', '10');

  const res = await request(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: buildAuthHeader(ENV.CONFLUENCE_EMAIL, ENV.CONFLUENCE_API_TOKEN),
      Accept: 'application/json',
    },
  });
  if (res.statusCode >= 400) {
    const text = await res.body.text();
    throw new Error(`Confluence search failed ${res.statusCode}: ${text}`);
  }
  return res.body.json();
}

async function confluenceGetPageContent(pageId: string) {
  const url = new URL(`/wiki/rest/api/content/${pageId}`, ENV.CONFLUENCE_BASE_URL);
  url.searchParams.set('expand', 'body.storage,version,space');

  const res = await request(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: buildAuthHeader(ENV.CONFLUENCE_EMAIL, ENV.CONFLUENCE_API_TOKEN),
      Accept: 'application/json',
    },
  });
  if (res.statusCode >= 400) {
    const text = await res.body.text();
    throw new Error(`Confluence get page failed ${res.statusCode}: ${text}`);
  }
  return res.body.json();
}

const server = new Server({
  name: 'confluence-mcp',
  version: '0.1.0',
}, {
  capabilities: {
    tools: {},
  },
});

server.tool('confluence.search', {
  description: 'Search Confluence with a CQL text query and return results',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Free text to search via CQL text ~' },
    },
    required: ['query'],
  },
}, async ({ query }) => {
  const data = await confluenceSearch(query);
  return { content: [{ type: 'json', json: data }] };
});

server.tool('confluence.getPage', {
  description: 'Fetch a Confluence page content by id (storage format)',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
}, async ({ id }) => {
  const data = await confluenceGetPageContent(id);
  return { content: [{ type: 'json', json: data }] };
});

const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  console.error('MCP server failed to start', err);
  process.exit(1);
});
