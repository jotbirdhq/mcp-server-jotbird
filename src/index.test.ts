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
  it("returns publish, list_documents, and delete", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(["publish", "list_documents", "delete"]);
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

  it("returns validation error when slug is missing", async () => {
    const result = await client.callTool({
      name: "delete",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Validation error");
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
