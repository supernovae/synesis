import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import client from "./client";

function mockFetch(response: Response) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return Promise.resolve(response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("api client", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { cookie: "synesis_admin_csrf=csrf-token" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefixes API URLs, serializes params, and returns data", async () => {
    const fetchMock = mockFetch(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await client.get<{ ok: boolean }>("/models", {
      params: { q: "coder", empty: undefined },
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/models?q=coder", expect.objectContaining({
      method: "GET",
      credentials: "include",
    }));
    expect(result.data).toEqual({ ok: true });
  });

  it("posts JSON with credentials and CSRF", async () => {
    const fetchMock = mockFetch(new Response(JSON.stringify({ id: 1 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await client.post("/tokens", { name: "dev" });
    const init = fetchMock.mock.calls[0]?.[1];
    const headers = init?.headers as Headers;

    expect(init?.body).toBe(JSON.stringify({ name: "dev" }));
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Synesis-CSRF")).toBe("csrf-token");
    expect(init?.credentials).toBe("include");
  });

  it("lets the browser set multipart boundaries for FormData", async () => {
    const fetchMock = mockFetch(new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const form = new FormData();
    form.append("file", new Blob(["x"]), "x.txt");

    await client.post("/ingestion/bootstrap", form, {
      headers: { "Content-Type": "multipart/form-data" },
    });
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;

    expect(headers.has("Content-Type")).toBe(false);
    expect(headers.get("X-Synesis-CSRF")).toBe("csrf-token");
  });

  it("throws FastAPI error details on non-2xx responses", async () => {
    mockFetch(new Response(JSON.stringify({ detail: "bad request" }), {
      status: 400,
      statusText: "Bad Request",
      headers: { "Content-Type": "application/json" },
    }));

    await expect(client.get("/bad")).rejects.toMatchObject({
      response: {
        status: 400,
        data: { detail: "bad request" },
      },
    });
  });
});
