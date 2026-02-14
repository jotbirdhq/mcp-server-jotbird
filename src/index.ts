#!/usr/bin/env node

// Polyfill fetch for Node < 18 where it isn't globally available.
if (typeof globalThis.fetch === "undefined") {
  const mod = await import("node-fetch");
  Object.assign(globalThis, {
    fetch: mod.default,
    Headers: mod.Headers,
    Request: mod.Request,
    Response: mod.Response,
  });
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const VERSION = "0.1.4";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PublishParams {
  markdown: string;
  title?: string;
  slug?: string;
}

interface PublishResult {
  slug: string;
  url: string;
  title?: string;
  expiresAt: string | null;
  ttlDays: number | null;
  created: boolean;
}

interface Document {
  slug: string;
  title: string;
  url: string;
  source: string;
  updatedAt: string;
  publishedAt: string;
  expiresAt: string | null;
}

// ---------------------------------------------------------------------------
// Argument schemas
// ---------------------------------------------------------------------------

const PublishArgs = z.object({
  markdown: z.string().describe("The Markdown content to publish"),
  title: z.string().optional().describe("Optional document title"),
  slug: z
    .string()
    .optional()
    .describe(
      "Slug of an existing page to update. Omit to publish a new page with an auto-generated slug."
    ),
});

const DeleteArgs = z.object({
  slug: z.string().describe("The slug of the document to delete"),
});

// ---------------------------------------------------------------------------
// MCP server factory (exported for testing)
// ---------------------------------------------------------------------------

export function createServer(apiKey: string, apiBase: string): Server {
  // -- API helpers (closed over apiKey/apiBase) --

  async function apiRequest<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const res = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": `mcp-server-jotbird/${VERSION}`,
        ...options.headers,
      },
    });

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After");
        throw new Error(
          `Rate limit exceeded.${retryAfter ? ` Try again in ${retryAfter} seconds.` : ""}`
        );
      }
      const msg =
        (data as Record<string, unknown>)?.error ?? `HTTP ${res.status}`;
      throw new Error(String(msg));
    }

    return data as T;
  }

  async function publishDocument(
    params: PublishParams
  ): Promise<PublishResult> {
    return apiRequest<PublishResult>("/api/v1/publish", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async function listDocuments(): Promise<{ documents: Document[] }> {
    return apiRequest<{ documents: Document[] }>("/api/v1/documents");
  }

  async function deleteDocument(slug: string): Promise<{ ok: boolean }> {
    return apiRequest<{ ok: boolean }>(
      `/api/v1/documents?slug=${encodeURIComponent(slug)}`,
      { method: "DELETE" }
    );
  }

  // -- Server setup --

  const server = new Server(
    { name: "mcp-server-jotbird", version: VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "publish",
        description:
          "Publish Markdown content as a beautifully formatted web page with a " +
          "shareable URL on JotBird. Use when the user wants to share, publish, " +
          "or host written content online. Supports full Markdown including " +
          "headings, lists, code blocks, tables, footnotes, and math. " +
          "To update an existing page, pass its slug.",
        inputSchema: {
          type: "object" as const,
          properties: {
            markdown: {
              type: "string",
              description:
                "Markdown content to publish. Supports standard Markdown plus " +
                "footnotes, task lists, definition lists, math ($…$ and $$…$$), " +
                "and inline HTML. Max 256 KB.",
            },
            title: {
              type: "string",
              description:
                "Page title. If omitted, the first H1 in the Markdown is used.",
            },
            slug: {
              type: "string",
              description:
                "Slug of an existing page to update. " +
                "Custom slugs cannot be created — omit this to publish a new page with an auto-generated slug. " +
                "Use list_documents to find slugs of existing pages.",
            },
          },
          required: ["markdown"],
        },
      },
      {
        name: "list_documents",
        description:
          "List the user's published JotBird pages. Use to check what's already " +
          "published, find a slug for updating or deleting, or see expiration dates. " +
          "Returns each page's title, URL, slug, and expiration.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "delete",
        description:
          "Permanently delete a published JotBird page and its shareable URL. " +
          "Use when the user wants to take down or remove a published page. " +
          "This cannot be undone.",
        inputSchema: {
          type: "object" as const,
          properties: {
            slug: {
              type: "string",
              description:
                "Slug of the page to delete (e.g. 'my-notes'). " +
                "Use list_documents to find slugs.",
            },
          },
          required: ["slug"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "publish": {
          const { markdown, title, slug } = PublishArgs.parse(args);
          const result = await publishDocument({ markdown, title, slug });

          const action = result.created ? "Published" : "Updated";
          const expiry = result.expiresAt
            ? `\nExpires: ${result.expiresAt}`
            : "\nExpires: never (Pro)";

          return {
            content: [
              {
                type: "text" as const,
                text:
                  `${action}: ${result.url}\n` +
                  `Slug: ${result.slug}\n` +
                  `Title: ${result.title ?? "(untitled)"}` +
                  expiry,
              },
            ],
          };
        }

        case "list_documents": {
          const { documents } = await listDocuments();

          if (documents.length === 0) {
            return {
              content: [
                { type: "text" as const, text: "No documents found." },
              ],
            };
          }

          const lines = documents.map((d) => {
            const expires = d.expiresAt ?? "never";
            return `- **${d.title || "(untitled)"}**\n  ${d.url}\n  slug: ${d.slug} · expires: ${expires}`;
          });

          return {
            content: [
              {
                type: "text" as const,
                text: `${documents.length} document(s):\n\n${lines.join("\n\n")}`,
              },
            ],
          };
        }

        case "delete": {
          const { slug } = DeleteArgs.parse(args);
          await deleteDocument(slug);
          return {
            content: [
              {
                type: "text" as const,
                text: `Deleted document "${slug}".`,
              },
            ],
          };
        }

        default:
          return {
            content: [
              { type: "text" as const, text: `Unknown tool: ${name}` },
            ],
            isError: true,
          };
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issues = error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        return {
          content: [
            {
              type: "text" as const,
              text: `Validation error: ${issues}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Start (only when run directly, not when imported by tests)
// ---------------------------------------------------------------------------

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    const scriptPath = realpathSync(process.argv[1]);
    const modulePath = fileURLToPath(import.meta.url);
    return scriptPath === modulePath;
  } catch {
    return false;
  }
})();

if (isMain) {
  const apiKey = process.env.JOTBIRD_API_KEY;
  if (!apiKey) {
    console.error(
      "Error: JOTBIRD_API_KEY environment variable is required.\n" +
        "Get your API key at: https://www.jotbird.com/account"
    );
    process.exit(1);
  }

  const apiBase = process.env.JOTBIRD_API_URL || "https://www.jotbird.com";
  const server = createServer(apiKey, apiBase);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`JotBird MCP server v${VERSION} running on stdio`);
}
