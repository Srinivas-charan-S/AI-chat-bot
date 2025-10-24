import 'dotenv/config';
import { App } from '@slack/bolt';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListToolsResultSchema, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

const ENV = z.object({
  SLACK_BOT_TOKEN: z.string(),
  SLACK_SIGNING_SECRET: z.string(),
  GOOGLE_GEMINI_API_KEY: z.string(),
  CONFLUENCE_BASE_URL: z.string().url(),
  CONFLUENCE_EMAIL: z.string(),
  CONFLUENCE_API_TOKEN: z.string(),
}).parse(process.env);

async function createMcpClient() {
  // Build safe env (string-only) for child process
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => typeof v === 'string') as Array<[string, string]>
  ) as Record<string, string>;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--loader', 'tsx', '-r', 'dotenv/config', './packages/mcp-confluence-server/src/index.ts'],
    env,
    cwd: process.cwd(),
    stderr: 'inherit' as any,
  });
  await transport.start();

  const client = new Client({ name: 'slack-bot', version: '0.1.0' });
  await client.connect(transport);
  return { client, transport };
}

async function askWithConfluenceContext(question: string) {
  const { client, transport } = await createMcpClient();
  try {
    const listTools = await client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema);
    void listTools;

    // Parallel search across Confluence, SharePoint, and Quip
    const [confluenceSearch, sharepointSearch, quipSearch] = await Promise.all([
      client.request(
        { method: 'tools/call', params: { name: 'confluence.search', arguments: { query: question } } },
        CallToolResultSchema
      ),
      client.request(
        { method: 'tools/call', params: { name: 'sharepoint.search', arguments: { query: question } } },
        CallToolResultSchema
      ).catch(err => ({ content: [{ type: 'text', text: `sharepoint error: ${err?.message || String(err)}` }] })),
      client.request(
        { method: 'tools/call', params: { name: 'quip.search', arguments: { query: question } } },
        CallToolResultSchema
      ).catch(err => ({ content: [{ type: 'text', text: `quip error: ${err?.message || String(err)}` }] })),
    ]);

    const confluenceText = (confluenceSearch as any).content?.find((c: any) => c.type === 'text')?.text || '{}';
    const sharepointText = (sharepointSearch as any).content?.find((c: any) => c.type === 'text')?.text || '{}';
    const quipText = (quipSearch as any).content?.find((c: any) => c.type === 'text')?.text || '{}';

    const confluence = safeJson(confluenceText);
    const sharepoint = safeJson(sharepointText);
    const quip = safeJson(quipText);

    // Confluence: fetch top page for richer context
    let pageContent: any | undefined;
    if (Array.isArray(confluence?.results) && confluence.results.length > 0) {
      const topPageId = confluence.results[0]?.content?._id || confluence.results[0]?.id || confluence.results[0]?.content?.id;
      if (topPageId) {
        const page = await client.request(
          { method: 'tools/call', params: { name: 'confluence.getPage', arguments: { id: String(topPageId) } } },
          CallToolResultSchema
        );
        const pageText = (page as any).content?.find((c: any) => c.type === 'text')?.text || '{}';
        pageContent = safeJson(pageText);
      }
    }

    const genAI = new GoogleGenerativeAI(ENV.GOOGLE_GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const system = `You are a helpful assistant answering questions using enterprise docs. If context is missing, say you don't know.`;
    const aggregated = {
      confluenceTopPage: pageContent ?? null,
      confluenceSearch: confluence,
      sharepointSearch: sharepoint,
      quipSearch: quip,
    };
    const contextText = JSON.stringify(aggregated).slice(0, 12000);

    const response = await model.generateContent({
      contents: [
        { role: 'user', parts: [{ text: `${system}\n\nQuestion: ${question}\n\nContext (JSON excerpt):\n${contextText}` }] }
      ],
      generationConfig: { temperature: 0.2 }
    });
    return response.response.text() || 'No answer generated.';
  } finally {
    await transport.close();
  }
}

function safeJson(text: string) {
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

const app = new App({
  token: ENV.SLACK_BOT_TOKEN,
  signingSecret: ENV.SLACK_SIGNING_SECRET,
  appToken: process.env.SLACK_APP_TOKEN, // optional for Socket Mode
  socketMode: !!process.env.SLACK_APP_TOKEN,
});

app.message(async ({ message, say }) => {
  if (!('text' in message) || !message.text) return;
  const question = message.text.trim();
  await say('Searching Confluence and thinking…');
  try {
    const answer = await askWithConfluenceContext(question);
    await say(answer);
  } catch (err: any) {
    await say(`Error: ${err?.message || String(err)}`);
  }
});

(async () => {
  await app.start(Number(process.env.PORT || 3000));
  // eslint-disable-next-line no-console
  console.log('Slack bot is running');
})();
