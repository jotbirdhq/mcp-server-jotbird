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
import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Read the version from package.json so the User-Agent and MCP server identity
// always match the published release instead of a hand-edited literal that
// drifts. tsc emits dist/index.js flat, so "../package.json" is the package
// root. createRequire avoids needing resolveJsonModule for a static import.
const require = createRequire(import.meta.url);
const VERSION: string = require("../package.json").version;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PublishParams {
  markdown: string;
  title?: string;
  slug?: string;
  namespaced?: boolean;
}

interface PublishResult {
  slug: string;
  url: string;
  title?: string;
  username?: string | null;
  expiresAt: string | null;
  ttlDays: number | null;
  created: boolean;
}

interface Document {
  slug: string;
  title: string;
  url: string;
  username: string | null;
  source: string;
  updatedAt: string;
  publishedAt: string;
  expiresAt: string | null;
}

// The public settings representation returned by both GET and PATCH
// /api/v1/documents/{slug}/settings (PageSettingsView in openapi.yaml).
// `tags` is optional, not required: the documents list stays DB-only and can lag
// for legacy (pre-2026-07) docs, so don't let the type promise a field the API
// may omit — formatSettings guards it.
interface PageSettingsView {
  slug: string;
  username: string | null;
  url: string;
  title: string | null;
  theme: string;
  hideBranding: boolean;
  visibility: "unlisted" | "password" | "public";
  tags?: string[];
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
      "Slug of an existing page to update. A slug that matches no page you own is IGNORED " +
      "(the page publishes at an auto-generated slug) — it cannot name a NEW flat page. " +
      "For namespaced documents (namespaced: true): required — publish at @username/slug."
    ),
  namespaced: z
    .boolean()
    .optional()
    .describe(
      "When true, publish at your namespace: share.jotbird.com/@username/slug. " +
      "Requires a Pro subscription and a username set in Account Settings. " +
      "A slug is required when namespaced is true."
    ),
})
  // Strict for the same reason as the settings schemas: a stripped key is a
  // silent partial success. A model that passes `theme` here (settings belong to
  // update_settings) should be told, not quietly published with the default.
  .strict();

const THEMES = ["default", "minimal", "essay", "terminal"] as const;
const VISIBILITIES = ["unlisted", "password", "public"] as const;

/**
 * Split an "@username/slug" identifier into its parts.
 *
 * list_documents reports a namespaced page's identity as "@username/slug", and
 * the tool descriptions point at it to find slugs — so that string is exactly
 * what a model passes back. Taken literally it addresses a FLAT slug that does
 * not exist, and the call 404s on a page that plainly does. Mirrors
 * parseSlugValue/resolveTarget in the CLI.
 */
function parseTarget(
  slug: string,
  namespaced?: boolean
): { slug: string; namespaced: boolean } {
  if (slug.startsWith("@") && slug.includes("/")) {
    return { slug: slug.slice(slug.indexOf("/") + 1), namespaced: true };
  }
  return { slug, namespaced: Boolean(namespaced) };
}

// Every tool that addresses an existing page shares this target, and it
// NORMALIZES ITSELF: parsing yields the resolved {slug, namespaced} and nothing
// else, so a handler cannot forget to call parseTarget (three hand-written call
// sites is how the "@username/slug" bug shipped in the first place). `target`
// preserves what the caller actually typed, for echoing back in messages.
//
// The post-transform length check is the load-bearing half: "@user/" splits to
// an EMPTY slug, which would otherwise sail through `z.string()` and request
// `/api/v1/documents//settings` — and `delete` would then cheerfully confirm a
// deletion that never happened.
//
// `.strict()` matters for the same class of reason: zod's default is to STRIP
// unknown keys, which would turn a patch the server rejects (its contract 400s
// on an unknown key) into a silent partial success. `tags` is the trap —
// get_settings reports them, so a model naturally tries to set them, and a
// stripped key would come back as "Settings updated".
const TargetShape = {
  slug: z
    .string()
    .trim()
    .min(1)
    .describe("Slug of the page, or the full @username/slug identifier"),
  namespaced: z
    .boolean()
    .optional()
    .describe("When true, resolve the slug at @username/slug instead of the flat URL."),
};

function normalizeTarget<T extends { slug: string; namespaced?: boolean }>(a: T) {
  return { ...a, ...parseTarget(a.slug, a.namespaced), target: a.slug };
}

const EMPTY_SLUG =
  'slug must name a page, e.g. "my-notes" or "@username/my-notes".';
const hasSlug = (a: { slug: string }) => a.slug.length > 0;

const TargetArgs = z.object(TargetShape).strict();

// get_settings and delete take nothing but a target, so they share one schema.
const NormalizedTargetArgs = TargetArgs.transform(normalizeTarget).refine(
  hasSlug,
  { message: EMPTY_SLUG, path: ["slug"] }
);

const GetSettingsArgs = NormalizedTargetArgs;
const DeleteArgs = NormalizedTargetArgs;

const UpdateSettingsArgs = TargetArgs.extend({
  theme: z.enum(THEMES).optional().describe("Page theme"),
  hideBranding: z
    .boolean()
    .optional()
    .describe("Hide the JotBird footer branding (true is Pro-only)"),
  visibility: z.enum(VISIBILITIES).optional().describe("Page visibility state"),
  password: z
    .string()
    .optional()
    .describe("Page password; required with (and only valid with) visibility \"password\""),
})
  // These mirror the server's validation. Rejecting locally matters because a
  // PATCH is charged against the hourly rate limit BEFORE validation — a
  // request the server will always refuse would still burn a write.
  //
  // One superRefine rather than chained .refine()s: chained refinements abort at
  // the first failure, so `{password}` with no visibility reported only the
  // generic "provide at least one setting" and never mentioned the password it
  // was about to drop. superRefine collects every issue, and the explicit paths
  // keep the rendered message field-anchored.
  .superRefine((a, ctx) => {
    if (a.password !== undefined && a.visibility !== "password") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["password"],
        message: 'password is only valid with visibility "password".',
      });
    }
    if (a.visibility === "password" && (a.password ?? "") === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["password"],
        message: 'visibility "password" requires a non-empty password.',
      });
    }
    if (
      a.theme === undefined &&
      a.hideBranding === undefined &&
      a.visibility === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message:
          "Provide at least one setting to change: theme, hideBranding, or visibility.",
      });
    }
  })
  .transform(normalizeTarget)
  .refine(hasSlug, { message: EMPTY_SLUG, path: ["slug"] });

// Derived from the schema rather than hand-written, so the two can't drift: a
// hand-rolled `theme?: string` would typecheck a value the schema forbids.
type SettingsPatch = Omit<
  z.infer<typeof UpdateSettingsArgs>,
  "slug" | "namespaced" | "target"
>;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatSettings(s: PageSettingsView): string {
  const identifier = s.username ? `@${s.username}/${s.slug}` : s.slug;
  const lines = [
    `Slug: ${identifier}`,
    `URL: ${s.url}`,
    // `||`, not `??`: an untitled page comes back as "" as readily as null, and
    // `??` would render a bare "Title: ".
    `Title: ${s.title || "(untitled)"}`,
    `Theme: ${s.theme}`,
    `Branding: ${s.hideBranding ? "hidden" : "shown"}`,
    `Visibility: ${s.visibility}`,
  ];
  if (s.tags?.length) lines.push(`Tags: ${s.tags.join(", ")}`);
  lines.push(`Expires: ${s.expiresAt ?? "never"}`);
  return lines.join("\n");
}

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
      const body = data as Record<string, unknown> | null;
      let msg = String(body?.error ?? `HTTP ${res.status}`);
      // Pro-gated settings 403s name the offending setting — surface it so the
      // model can tell the user which feature needs Pro instead of guessing.
      if (res.status === 403 && body?.setting) {
        msg += ` (Pro required for: ${String(body.setting)})`;
      }
      throw new Error(msg);
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

  async function deleteDocument(slug: string, namespaced?: boolean): Promise<{ ok: boolean }> {
    const params = new URLSearchParams({ slug });
    if (namespaced) params.set("namespaced", "true");
    return apiRequest<{ ok: boolean }>(
      `/api/v1/documents?${params.toString()}`,
      { method: "DELETE" }
    );
  }

  function settingsPath(slug: string, namespaced?: boolean): string {
    let path = `/api/v1/documents/${encodeURIComponent(slug)}/settings`;
    if (namespaced) path += "?namespaced=true";
    return path;
  }

  async function getSettings(
    slug: string,
    namespaced?: boolean
  ): Promise<PageSettingsView> {
    return apiRequest<PageSettingsView>(settingsPath(slug, namespaced));
  }

  async function updateSettings(
    slug: string,
    patch: SettingsPatch,
    namespaced?: boolean
  ): Promise<PageSettingsView> {
    return apiRequest<PageSettingsView>(settingsPath(slug, namespaced), {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
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
          "To update an existing page, pass its slug. " +
          "Pro users with a username can publish at a permanent namespaced URL " +
          "(share.jotbird.com/@username/slug) by passing namespaced: true and a slug.",
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
                "Slug of an EXISTING page to update — NOT a way to choose the URL of a new " +
                "page. If it does not match a page this account already owns, it is IGNORED " +
                "and the page is published at an auto-generated slug instead, so never promise " +
                "the user a URL you passed here — report the one the tool returns. " +
                "Omit it to publish a new page. To choose a new page's URL, use namespaced: " +
                "true together with a slug (Pro). Use list_documents to find existing slugs.",
            },
            namespaced: {
              type: "boolean",
              description:
                "When true, publish at your namespace: share.jotbird.com/@username/slug. " +
                "Requires a Pro subscription and a username set in Account Settings. " +
                "A slug must be provided.",
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
          "This cannot be undone. For namespaced pages (@username/slug), pass namespaced: true.",
        inputSchema: {
          type: "object" as const,
          properties: {
            slug: {
              type: "string",
              description:
                "Slug of the page to delete (e.g. 'my-notes'), or the full " +
                "'@username/my-notes' identifier for a namespaced page. " +
                "Use list_documents to find slugs.",
            },
            namespaced: {
              type: "boolean",
              description:
                "When true, delete the document at @username/slug instead of the flat URL. " +
                "Unnecessary if the slug already starts with '@username/'. " +
                "Requires a Pro subscription and a username set in Account Settings.",
            },
          },
          required: ["slug"],
        },
      },
      {
        name: "get_settings",
        description:
          "Get a published JotBird page's settings: theme, branding, visibility " +
          "(unlisted/password/public), tags, and expiration. Use before changing " +
          "settings or when the user asks how a page is configured. The page " +
          "password is write-only and never returned.",
        inputSchema: {
          type: "object" as const,
          properties: {
            slug: {
              type: "string",
              description:
                "Slug of the page (e.g. 'my-notes'), or the full '@username/my-notes' " +
                "identifier for a namespaced page. Use list_documents to find slugs.",
            },
            namespaced: {
              type: "boolean",
              description:
                "When true, resolve the slug at @username/slug instead of the flat URL. " +
                "Unnecessary if the slug already starts with '@username/'.",
            },
          },
          required: ["slug"],
        },
      },
      {
        name: "update_settings",
        description:
          "Update a published JotBird page's settings: theme, branding, and " +
          "visibility. Only the provided fields change; others are preserved. " +
          "Pro-only: non-default themes, hiding branding, and password " +
          "protection (free accounts can clear these and switch " +
          "unlisted/public). Visibility semantics: 'unlisted' (default — not " +
          "indexed by search engines), 'public' (indexable, listed in the " +
          "sitemap), 'password' (Pro — requires the password argument; setting " +
          "a visibility clears any previous password). The API reflects changes " +
          "immediately, but the live page can take up to about a minute to " +
          "reflect a visibility change as caches refresh — a briefly stale page " +
          "is not a failed update.",
        inputSchema: {
          type: "object" as const,
          properties: {
            slug: {
              type: "string",
              description:
                "Slug of the page to update (e.g. 'my-notes'), or the full " +
                "'@username/my-notes' identifier for a namespaced page. " +
                "Use list_documents to find slugs.",
            },
            namespaced: {
              type: "boolean",
              description:
                "When true, resolve the slug at @username/slug instead of the flat URL. " +
                "Unnecessary if the slug already starts with '@username/'.",
            },
            theme: {
              type: "string",
              enum: [...THEMES],
              description:
                "Page theme. Any non-default theme requires a Pro subscription.",
            },
            hideBranding: {
              type: "boolean",
              description:
                "Hide the 'Published with JotBird' footer. Enabling requires Pro; " +
                "any account can set it back to false.",
            },
            visibility: {
              type: "string",
              enum: [...VISIBILITIES],
              description:
                "Page visibility: 'unlisted' (default), 'public' (search-indexable), " +
                "or 'password' (Pro; requires the password argument).",
            },
            password: {
              type: "string",
              description:
                "Page password. Required with (and only valid with) visibility " +
                "'password'. Write-only — it is never echoed back.",
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
          const { markdown, title, slug, namespaced } = PublishArgs.parse(args);
          const result = await publishDocument({ markdown, title, slug, namespaced });

          const action = result.created ? "Published" : "Updated";
          const expiry = result.expiresAt
            ? `\nExpires: ${result.expiresAt}`
            : "\nExpires: never (Pro)";
          const identifier = result.username
            ? `@${result.username}/${result.slug}`
            : result.slug;

          return {
            content: [
              {
                type: "text" as const,
                text:
                  `${action}: ${result.url}\n` +
                  `Slug: ${identifier}\n` +
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
            const identifier = d.username ? `@${d.username}/${d.slug}` : d.slug;
            return `- **${d.title || "(untitled)"}**\n  ${d.url}\n  slug: ${identifier} · expires: ${expires}`;
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
          const { slug, namespaced, target } = DeleteArgs.parse(args);
          await deleteDocument(slug, namespaced);
          return {
            content: [
              {
                type: "text" as const,
                text: `Deleted document "${target}".`,
              },
            ],
          };
        }

        case "get_settings": {
          const { slug, namespaced } = GetSettingsArgs.parse(args);
          const settings = await getSettings(slug, namespaced);
          return {
            content: [{ type: "text" as const, text: formatSettings(settings) }],
          };
        }

        case "update_settings": {
          const { slug, namespaced, target: _target, ...patch } =
            UpdateSettingsArgs.parse(args);

          // Pre-flight every write with the GET (which is not rate-limited):
          // PATCH is charged against the hourly write limit BEFORE validation,
          // even when it 404s, so a mistyped slug would otherwise silently eat
          // one of a free account's 10 writes per hour.
          //
          // The result is deliberately NOT used to skip a PATCH whose values
          // already match. Re-applying identical settings is the documented way
          // to repair drift and to finish a partially-applied patch ("a retry of
          // the same PATCH is idempotent" — PAGE_SETTINGS_ARCHITECTURE.md), and
          // the CLI always writes. Saving a rate-limit unit isn't worth being the
          // one client that can't force a re-apply.
          await getSettings(slug, namespaced);

          const settings = await updateSettings(slug, patch, namespaced);
          const note =
            patch.visibility !== undefined
              ? "\n\nNote: the live page can take up to about a minute to reflect " +
                "a visibility change as caches refresh."
              : "";
          return {
            content: [
              {
                type: "text" as const,
                text: `Settings updated.\n${formatSettings(settings)}${note}`,
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
        // Cross-field refinements can carry an empty path; prefixing those with
        // ": " renders a stray double colon ("Validation error: : Provide …").
        const issues = error.issues
          .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
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
