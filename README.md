# mcp-server-jotbird

An [MCP](https://modelcontextprotocol.io/) server for [JotBird](https://www.jotbird.com) that lets any LLM publish Markdown as beautifully formatted, shareable web pages.

Write a document in conversation, publish it with one tool call, and get back a live URL. Supports full Markdown — headings, code blocks, tables, footnotes, math, task lists, and more. Update or delete pages by slug.

Works with Claude, ChatGPT, Gemini, and any MCP-compatible client.

## Quick start

### 1. Get an API key

Sign in at [jotbird.com](https://www.jotbird.com), open **Account > API keys**, and generate a key.

### 2. Add to your client

<details open>
<summary><strong>Claude Desktop</strong></summary>

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "jotbird": {
      "command": "npx",
      "args": ["-y", "mcp-server-jotbird"],
      "env": {
        "JOTBIRD_API_KEY": "jb_your_key_here"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add jotbird -e JOTBIRD_API_KEY=jb_your_key_here -- npx -y mcp-server-jotbird
```

</details>

<details>
<summary><strong>ChatGPT</strong></summary>

ChatGPT connectors require a remote (HTTP) MCP server — they don't support local stdio servers directly. To use this server with ChatGPT:

1. Host the server behind an HTTP transport (e.g. using [`mcp-proxy`](https://github.com/nichochar/mcp-proxy) or [`supergateway`](https://github.com/nichochar/supergateway))
2. In ChatGPT, go to **Settings > Connectors > Create**
3. Enter the URL of your hosted server

See [OpenAI's MCP docs](https://platform.openai.com/docs/mcp) for details.

</details>

<details>
<summary><strong>Gemini CLI</strong></summary>

Edit `.gemini/settings.json` (project-level) or `~/.gemini/settings.json` (global):

```json
{
  "mcpServers": {
    "jotbird": {
      "command": "npx",
      "args": ["-y", "mcp-server-jotbird"],
      "env": {
        "JOTBIRD_API_KEY": "$JOTBIRD_API_KEY"
      }
    }
  }
}
```

Or add via CLI:

```bash
gemini mcp add jotbird -- npx -y mcp-server-jotbird
```

See [Gemini CLI MCP docs](https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html) for details.

</details>

<details>
<summary><strong>Other MCP clients</strong></summary>

Any client that supports the [Model Context Protocol](https://modelcontextprotocol.io/) over stdio can use this server. Set the `JOTBIRD_API_KEY` environment variable and run:

```bash
npx -y mcp-server-jotbird
```

</details>

### 3. Use it

Ask your LLM things like:

- *"Write a blog post about X and publish it to JotBird"*
- *"Publish these meeting notes as a shareable page"*
- *"Update my published page 'my-notes' with this new section"*
- *"Show me all my published pages"*
- *"Take down the page with slug 'old-draft'"*

## Tools

### `publish`

Publish Markdown content as a formatted web page with a shareable URL. To update an existing page, pass its slug.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `markdown` | Yes | Markdown content (max 256 KB). Supports footnotes, task lists, definition lists, math (`$…$` and `$$…$$`), and inline HTML. |
| `title` | No | Page title. If omitted, the first H1 in the Markdown is used. |
| `slug` | No | Slug of an existing page to update. Custom slugs cannot be created — omit this to publish a new page with an auto-generated slug. Use `list_documents` to find slugs. |

### `list_documents`

List the user's published pages. Returns each page's title, URL, slug, and expiration date.

No parameters.

### `delete`

Permanently delete a published page and its shareable URL. Cannot be undone.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `slug` | Yes | Slug of the page to delete. Use `list_documents` to find slugs. |

## Limits

|  | Free | Pro |
|--|------|-----|
| Published pages | 10 | Unlimited |
| Publishes per hour | 10 | 100 |
| Page expiration | 90 days | Never |
| Max markdown size | 256 KB | 256 KB |

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JOTBIRD_API_KEY` | Yes | Your JotBird API key (`jb_...`) |
| `JOTBIRD_API_URL` | No | API base URL (default: `https://www.jotbird.com`) |

## Development

```bash
npm install
npm run build
```

Test locally:

```bash
JOTBIRD_API_KEY=jb_your_key node dist/index.js
```

## License

MIT
