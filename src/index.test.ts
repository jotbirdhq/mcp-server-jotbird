import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "jb_test_key";
const TEST_API_BASE = "https://mock.jotbird.test";

let client: Client;
let fetchMock: ReturnType<typeof vi.fn>;

function mockFetchResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    })
  );
}

/** Extract the text from the first content block of a tool call result. */
function textOf(result: Awaited<ReturnType<typeof client.callTool>>): string {
  const block = result.content as Array<{ type: string; text: string }>;
  return block[0]?.text ?? "";
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  fetchMock = vi.fn();
  global.fetch = fetchMock;

  const server = createServer(TEST_API_KEY, TEST_API_BASE);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("listTools", () => {
  it("returns publish, list_documents, delete, get_settings, and update_settings", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      "publish",
      "list_documents",
      "delete",
      "get_settings",
      "update_settings",
    ]);
  });

  it("publish requires markdown", async () => {
    const { tools } = await client.listTools();
    const publish = tools.find((t) => t.name === "publish")!;
    expect(publish.inputSchema.required).toContain("markdown");
  });

  it("delete requires slug", async () => {
    const { tools } = await client.listTools();
    const del = tools.find((t) => t.name === "delete")!;
    expect(del.inputSchema.required).toContain("slug");
  });

  it("settings tools require slug", async () => {
    const { tools } = await client.listTools();
    for (const name of ["get_settings", "update_settings"]) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.inputSchema.required).toEqual(["slug"]);
    }
  });
});

describe("publish", () => {
  it("publishes and returns formatted result", async () => {
    mockFetchResponse({
      slug: "bright-calm-meadow",
      url: "https://share.jotbird.com/bright-calm-meadow",
      title: "Meeting Notes",
      expiresAt: "2025-09-01",
      ttlDays: 90,
      created: true,
    });

    const result = await client.callTool({
      name: "publish",
      arguments: { markdown: "# Meeting Notes\n\nHello world" },
    });

    const text = textOf(result);
    expect(text).toContain("Published:");
    expect(text).toContain("https://share.jotbird.com/bright-calm-meadow");
    expect(text).toContain("Slug: bright-calm-meadow");
    expect(text).toContain("Title: Meeting Notes");
    expect(text).toContain("Expires: 2025-09-01");

    // Verify the API was called correctly
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`${TEST_API_BASE}/api/v1/publish`);
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe(`Bearer ${TEST_API_KEY}`);
    expect(opts.headers["User-Agent"]).toMatch(/^mcp-server-jotbird\//);
  });

  it("shows 'Updated' when updating an existing page", async () => {
    mockFetchResponse({
      slug: "my-page",
      url: "https://share.jotbird.com/my-page",
      title: "My Page",
      expiresAt: null,
      ttlDays: null,
      created: false,
    });

    const result = await client.callTool({
      name: "publish",
      arguments: { markdown: "# Updated content", slug: "my-page" },
    });

    const text = textOf(result);
    expect(text).toContain("Updated:");
    expect(text).toContain("Expires: never (Pro)");
  });

  it("publishes namespaced and shows @username/slug", async () => {
    mockFetchResponse({
      slug: "my-page",
      url: "https://share.jotbird.com/@clayton-myers/my-page",
      title: "My Page",
      username: "clayton-myers",
      expiresAt: null,
      ttlDays: null,
      created: true,
    });

    const result = await client.callTool({
      name: "publish",
      arguments: { markdown: "# My Page", slug: "my-page", namespaced: true },
    });

    const text = textOf(result);
    expect(text).toContain("Published:");
    expect(text).toContain("https://share.jotbird.com/@clayton-myers/my-page");
    expect(text).toContain("Slug: @clayton-myers/my-page");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`${TEST_API_BASE}/api/v1/publish`);
    const body = JSON.parse(opts.body);
    expect(body.namespaced).toBe(true);
    expect(body.slug).toBe("my-page");
  });

  it("shows (untitled) when no title is returned", async () => {
    mockFetchResponse({
      slug: "abc",
      url: "https://share.jotbird.com/abc",
      title: null,
      expiresAt: null,
      ttlDays: null,
      created: true,
    });

    const result = await client.callTool({
      name: "publish",
      arguments: { markdown: "no heading here" },
    });

    expect(textOf(result)).toContain("Title: (untitled)");
  });

  it("returns validation error when markdown is missing", async () => {
    const result = await client.callTool({
      name: "publish",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Validation error");
  });

  it("rejects settings keys instead of publishing with them silently dropped", async () => {
    // Settings belong to update_settings. Stripping `theme` here would publish
    // with the default theme and still report success.
    const result = await client.callTool({
      name: "publish",
      arguments: { markdown: "# Test", theme: "essay" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Validation error");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("list_documents", () => {
  it("returns formatted list of documents", async () => {
    mockFetchResponse({
      documents: [
        {
          slug: "doc-one",
          title: "First Doc",
          url: "https://share.jotbird.com/doc-one",
          username: null,
          source: "mcp",
          updatedAt: "2025-01-01",
          publishedAt: "2025-01-01",
          expiresAt: "2025-04-01",
        },
        {
          slug: "doc-two",
          title: "Second Doc",
          url: "https://share.jotbird.com/doc-two",
          username: null,
          source: "mcp",
          updatedAt: "2025-01-02",
          publishedAt: "2025-01-02",
          expiresAt: null,
        },
      ],
    });

    const result = await client.callTool({
      name: "list_documents",
      arguments: {},
    });

    const text = textOf(result);
    expect(text).toContain("2 document(s)");
    expect(text).toContain("First Doc");
    expect(text).toContain("doc-one");
    expect(text).toContain("Second Doc");
    expect(text).toContain("expires: never");
  });

  it("shows @username/slug for namespaced documents", async () => {
    mockFetchResponse({
      documents: [
        {
          slug: "my-page",
          title: "My Page",
          url: "https://share.jotbird.com/@clayton-myers/my-page",
          username: "clayton-myers",
          source: "mcp",
          updatedAt: "2025-01-01",
          publishedAt: "2025-01-01",
          expiresAt: null,
        },
        {
          slug: "flat-doc",
          title: "Flat Doc",
          url: "https://share.jotbird.com/flat-doc",
          username: null,
          source: "mcp",
          updatedAt: "2025-01-02",
          publishedAt: "2025-01-02",
          expiresAt: null,
        },
      ],
    });

    const result = await client.callTool({
      name: "list_documents",
      arguments: {},
    });

    const text = textOf(result);
    expect(text).toContain("slug: @clayton-myers/my-page");
    expect(text).toContain("slug: flat-doc");
  });

  it("returns message when no documents exist", async () => {
    mockFetchResponse({ documents: [] });

    const result = await client.callTool({
      name: "list_documents",
      arguments: {},
    });

    expect(textOf(result)).toBe("No documents found.");
  });
});

describe("delete", () => {
  it("deletes a document and confirms", async () => {
    mockFetchResponse({ ok: true });

    const result = await client.callTool({
      name: "delete",
      arguments: { slug: "old-draft" },
    });

    expect(textOf(result)).toBe('Deleted document "old-draft".');

    // Verify correct URL with encoded slug
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`${TEST_API_BASE}/api/v1/documents?slug=old-draft`);
    expect(opts.method).toBe("DELETE");
  });

  it("deletes a namespaced document with namespaced=true query param", async () => {
    mockFetchResponse({ ok: true });

    const result = await client.callTool({
      name: "delete",
      arguments: { slug: "my-page", namespaced: true },
    });

    expect(textOf(result)).toBe('Deleted document "my-page".');

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`${TEST_API_BASE}/api/v1/documents?slug=my-page&namespaced=true`);
    expect(opts.method).toBe("DELETE");
  });

  it("accepts an @username/slug identifier and infers namespaced", async () => {
    mockFetchResponse({ ok: true });

    const result = await client.callTool({
      name: "delete",
      arguments: { slug: "@clayton-myers/my-page" },
    });

    expect(textOf(result)).toBe('Deleted document "@clayton-myers/my-page".');

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `${TEST_API_BASE}/api/v1/documents?slug=my-page&namespaced=true`
    );
  });

  it("returns validation error when slug is missing", async () => {
    const result = await client.callTool({
      name: "delete",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Validation error");
  });

  it("refuses a slug that normalizes to nothing rather than confirming a no-op delete", async () => {
    // delete({slug:"@user/"}) used to request ?slug= and then print
    // 'Deleted document "@user/".' — a success confirmation for nothing.
    for (const slug of ["", "@user/"]) {
      const result = await client.callTool({ name: "delete", arguments: { slug } });

      expect(result.isError).toBe(true);
      expect(textOf(result)).not.toContain("Deleted");
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("rejects unknown keys", async () => {
    const result = await client.callTool({
      name: "delete",
      arguments: { slug: "old-draft", force: true },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Validation error");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const SETTINGS_VIEW = {
  slug: "my-notes",
  username: null,
  url: "https://share.jotbird.com/my-notes",
  title: "My Notes",
  theme: "default",
  hideBranding: false,
  visibility: "unlisted",
  tags: ["work", "drafts"],
  expiresAt: null,
};

describe("get_settings", () => {
  it("returns formatted settings", async () => {
    mockFetchResponse(SETTINGS_VIEW);

    const result = await client.callTool({
      name: "get_settings",
      arguments: { slug: "my-notes" },
    });

    const text = textOf(result);
    expect(text).toContain("Slug: my-notes");
    expect(text).toContain("https://share.jotbird.com/my-notes");
    expect(text).toContain("Theme: default");
    expect(text).toContain("Branding: shown");
    expect(text).toContain("Visibility: unlisted");
    expect(text).toContain("Tags: work, drafts");
    expect(text).toContain("Expires: never");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`${TEST_API_BASE}/api/v1/documents/my-notes/settings`);
    expect(opts.method ?? "GET").toBe("GET");
  });

  it("resolves namespaced slugs and shows @username/slug", async () => {
    mockFetchResponse({
      ...SETTINGS_VIEW,
      username: "clayton-myers",
      url: "https://share.jotbird.com/@clayton-myers/my-notes",
      theme: "essay",
      hideBranding: true,
    });

    const result = await client.callTool({
      name: "get_settings",
      arguments: { slug: "my-notes", namespaced: true },
    });

    const text = textOf(result);
    expect(text).toContain("Slug: @clayton-myers/my-notes");
    expect(text).toContain("Theme: essay");
    expect(text).toContain("Branding: hidden");

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `${TEST_API_BASE}/api/v1/documents/my-notes/settings?namespaced=true`
    );
  });

  it("shows (untitled) for a blank title rather than a bare 'Title:'", async () => {
    mockFetchResponse({ ...SETTINGS_VIEW, title: "", tags: undefined });

    const result = await client.callTool({
      name: "get_settings",
      arguments: { slug: "my-notes" },
    });

    expect(textOf(result)).toContain("Title: (untitled)");
    // A legacy doc can come back without tags at all; don't render an empty line.
    expect(textOf(result)).not.toContain("Tags:");
  });

  it("accepts the @username/slug identifier list_documents prints", async () => {
    mockFetchResponse({ ...SETTINGS_VIEW, username: "clayton-myers" });

    await client.callTool({
      name: "get_settings",
      arguments: { slug: "@clayton-myers/my-notes" },
    });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `${TEST_API_BASE}/api/v1/documents/my-notes/settings?namespaced=true`
    );
  });

  it("returns validation error when slug is missing", async () => {
    const result = await client.callTool({
      name: "get_settings",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Validation error");
  });
});

describe("update_settings", () => {
  it("pre-flights with GET, then PATCHes the settings", async () => {
    mockFetchResponse(SETTINGS_VIEW); // pre-flight GET
    mockFetchResponse({ ...SETTINGS_VIEW, theme: "minimal", hideBranding: true });

    const result = await client.callTool({
      name: "update_settings",
      arguments: { slug: "my-notes", theme: "minimal", hideBranding: true },
    });

    const text = textOf(result);
    expect(text).toContain("Settings updated.");
    expect(text).toContain("Theme: minimal");
    expect(text).toContain("Branding: hidden");
    // No visibility in the patch → no propagation note.
    expect(text).not.toContain("up to about a minute");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [getUrl, getOpts] = fetchMock.mock.calls[0];
    expect(getUrl).toBe(`${TEST_API_BASE}/api/v1/documents/my-notes/settings`);
    expect(getOpts.method ?? "GET").toBe("GET");

    const [patchUrl, patchOpts] = fetchMock.mock.calls[1];
    expect(patchUrl).toBe(`${TEST_API_BASE}/api/v1/documents/my-notes/settings`);
    expect(patchOpts.method).toBe("PATCH");
    expect(JSON.parse(patchOpts.body)).toEqual({ theme: "minimal", hideBranding: true });
  });

  it("skips the PATCH when the pre-flight GET fails", async () => {
    mockFetchResponse({ error: "Document not found" }, 404);

    const result = await client.callTool({
      name: "update_settings",
      arguments: { slug: "nope", theme: "minimal" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Document not found");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("sets password protection and notes the propagation delay", async () => {
    mockFetchResponse(SETTINGS_VIEW);
    mockFetchResponse({ ...SETTINGS_VIEW, visibility: "password" });

    const result = await client.callTool({
      name: "update_settings",
      arguments: { slug: "my-notes", visibility: "password", password: "hunter2" },
    });

    const text = textOf(result);
    expect(text).toContain("Visibility: password");
    expect(text).toContain("up to about a minute");

    const [, patchOpts] = fetchMock.mock.calls[1];
    expect(JSON.parse(patchOpts.body)).toEqual({
      visibility: "password",
      password: "hunter2",
    });
  });

  it("targets namespaced documents with namespaced=true", async () => {
    mockFetchResponse({ ...SETTINGS_VIEW, username: "clayton-myers" });
    mockFetchResponse({
      ...SETTINGS_VIEW,
      username: "clayton-myers",
      visibility: "public",
    });

    await client.callTool({
      name: "update_settings",
      arguments: { slug: "my-notes", namespaced: true, visibility: "public" },
    });

    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe(
        `${TEST_API_BASE}/api/v1/documents/my-notes/settings?namespaced=true`
      );
    }
  });

  it("rejects an empty patch without calling the API", async () => {
    const result = await client.callTool({
      name: "update_settings",
      arguments: { slug: "my-notes" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("at least one setting");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a password without visibility 'password'", async () => {
    const result = await client.callTool({
      name: "update_settings",
      arguments: { slug: "my-notes", visibility: "public", password: "hunter2" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('only valid with visibility "password"');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports the password mistake even when the patch is otherwise empty", async () => {
    // Chained .refine()s aborted at the first failure, so this used to surface
    // only the generic "provide at least one setting" and never mentioned the
    // password it was about to drop.
    const result = await client.callTool({
      name: "update_settings",
      arguments: { slug: "my-notes", password: "hunter2" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('only valid with visibility "password"');
    expect(textOf(result)).toContain("at least one setting");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unknown keys instead of silently dropping them", async () => {
    // `tags` is the realistic trap: get_settings reports them, so a model tries
    // to set them. Stripping the key would PATCH only the theme and still report
    // "Settings updated", telling the user their tags were saved when they weren't.
    const result = await client.callTool({
      name: "update_settings",
      arguments: { slug: "my-notes", theme: "minimal", tags: ["work"] },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Validation error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders cross-field validation errors without a stray double colon", async () => {
    const result = await client.callTool({
      name: "update_settings",
      arguments: { slug: "my-notes" },
    });

    expect(textOf(result)).not.toContain(": :");
    expect(textOf(result)).toContain("Validation error: Provide at least one setting");
  });

  it("accepts an @username/slug identifier and infers namespaced", async () => {
    // This is the string list_documents prints, so it's what a model passes back.
    mockFetchResponse({ ...SETTINGS_VIEW, username: "clayton-myers" });
    mockFetchResponse({
      ...SETTINGS_VIEW,
      username: "clayton-myers",
      theme: "essay",
    });

    const result = await client.callTool({
      name: "update_settings",
      arguments: { slug: "@clayton-myers/my-notes", theme: "essay" },
    });

    expect(textOf(result)).toContain("Theme: essay");
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe(
        `${TEST_API_BASE}/api/v1/documents/my-notes/settings?namespaced=true`
      );
    }
  });

  it("re-applies identical settings instead of short-circuiting the write", async () => {
    // Re-applying the same values is the documented way to repair drift and to
    // finish a partially-applied patch ("a retry of the same PATCH is
    // idempotent"), and the CLI always writes. An earlier revision skipped the
    // PATCH when the values already matched, which quietly made MCP the one
    // client that couldn't force a re-apply.
    mockFetchResponse(SETTINGS_VIEW); // already theme=default, visibility=unlisted
    mockFetchResponse(SETTINGS_VIEW);

    const result = await client.callTool({
      name: "update_settings",
      arguments: { slug: "my-notes", theme: "default", visibility: "unlisted" },
    });

    expect(textOf(result)).toContain("Settings updated.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].method).toBe("PATCH");
  });

  it("rejects a slug that normalizes to nothing", async () => {
    // "@user/" splits to an EMPTY slug, which would request
    // /api/v1/documents//settings if the length check ran before normalization.
    for (const slug of ["", "   ", "@user/"]) {
      const result = await client.callTool({
        name: "update_settings",
        arguments: { slug, theme: "minimal" },
      });

      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("rejects visibility 'password' without a password", async () => {
    const result = await client.callTool({
      name: "update_settings",
      arguments: { slug: "my-notes", visibility: "password" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("requires a non-empty password");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid theme without calling the API", async () => {
    const result = await client.callTool({
      name: "update_settings",
      arguments: { slug: "my-notes", theme: "book" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Validation error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the Pro-gated setting from a 403", async () => {
    mockFetchResponse(SETTINGS_VIEW);
    mockFetchResponse({ error: "Pro subscription required", setting: "theme" }, 403);

    const result = await client.callTool({
      name: "update_settings",
      arguments: { slug: "my-notes", theme: "essay" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Pro subscription required");
    expect(textOf(result)).toContain("Pro required for: theme");
  });
});

describe("error handling", () => {
  it("returns API error message", async () => {
    mockFetchResponse({ error: "Document not found" }, 404);

    const result = await client.callTool({
      name: "delete",
      arguments: { slug: "nonexistent" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Document not found");
  });

  it("returns rate limit error with retry-after", async () => {
    mockFetchResponse({}, 429, { "Retry-After": "30" });

    const result = await client.callTool({
      name: "publish",
      arguments: { markdown: "# Test" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Rate limit exceeded");
    expect(textOf(result)).toContain("30 seconds");
  });

  it("handles generic HTTP error when no error field", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Internal Server Error", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      })
    );

    const result = await client.callTool({
      name: "list_documents",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("HTTP 500");
  });

  it("returns error for unknown tool", async () => {
    const result = await client.callTool({
      name: "nonexistent_tool",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Unknown tool: nonexistent_tool");
  });
});
