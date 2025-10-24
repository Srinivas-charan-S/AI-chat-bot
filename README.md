## Slack AI bot with Confluence MCP

This monorepo contains:
- `packages/mcp-confluence-server`: An MCP server exposing Confluence tools
- `packages/slack-bot`: A Slack Bolt app that calls the MCP tools and an LLM

### Setup
1. Copy `.env.example` to `.env` and fill values.
2. Install deps: `npm install`
3. Dev run Slack bot: `npm run dev -w @workspace/slack-bot`

### Notes
- The MCP server uses Confluence Cloud REST API with Basic auth (email + API token).
- The Slack bot spawns the MCP server via stdio and retrieves context for the question, then calls OpenAI to answer.
