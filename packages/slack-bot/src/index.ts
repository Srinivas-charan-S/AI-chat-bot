import 'dotenv/config';
import { App } from '@slack/bolt';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import OpenAI from 'openai';

const ENV = z.object({
  SLACK_BOT_TOKEN: z.string(),
  SLACK_SIGNING_SECRET: z.string(),
  OPENAI_API_KEY: z.string(),
  CONFLUENCE_BASE_URL: z.string().url(),
  CONFLUENCE_EMAIL: z.string(),
  CONFLUENCE_API_TOKEN: z.string(),
}).parse(process.env);

async function createMcpClient() {
  const child = execFile(
    process.execPath,
    ['--loader', 'tsx', '-r', 'dotenv/config', './packages/mcp-confluence-server/src/index.ts'],
    {
      env: process.env,
      cwd: process.cwd(),
    }
  );

  await once(child, 'spawn');

  const transport = new StdioClientTransport({
    readable: child.stdout!,
    writable: child.stdin!,
  });

  const client = new Client({ name: 'slack-bot', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, child };
}

async function askWithConfluenceContext(question: string) {
  const { client, child } = await createMcpClient();
  try {
    const search = await client.callTool({ name: 'confluence.search', arguments: { query: question } });
    const results = (search.content?.[0] as any)?.json;

    let topPageId: string | undefined;
    if (Array.isArray(results?.results) && results.results.length > 0) {
      topPageId = results.results[0]?.content?._id || results.results[0]?.id || results.results[0]?.content?.id;
    }

    let pageContent: any | undefined;
    if (topPageId) {
      const page = await client.callTool({ name: 'confluence.getPage', arguments: { id: String(topPageId) } });
      pageContent = (page.content?.[0] as any)?.json;
    }

    const openai = new OpenAI({ apiKey: ENV.OPENAI_API_KEY });
    const system = `You are a helpful assistant answering questions using Confluence context. If context is missing, say you don't know.`;
    const contextText = pageContent ? JSON.stringify(pageContent).slice(0, 12000) : 'No relevant page found.';

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Question: ${question}\n\nConfluence context (JSON storage excerpt):\n${contextText}` },
      ],
      temperature: 0.2,
    });

    return completion.choices[0]?.message?.content || 'No answer generated.';
  } finally {
    child.kill();
  }
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
