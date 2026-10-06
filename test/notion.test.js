import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// database-actions.js imports retryTimer; Notion functions don't use it but the import must resolve
vi.mock("../src/utilities.js", () => ({ retryTimer: vi.fn() }));

import {
  getTrackedDatabasesN,
  trackNewDatabaseN,
  getDatabaseIdN,
  getDatabaseSchemaN,
  uploadFileN,
  addRecordN,
  updateRecordN,
  getFilteredRecordsN,
} from "../src/database-actions.js";
import { createFetchMock, ok, reply } from "./helpers.js";

const N = "https://api.notion.com/v1";
const TOKEN = "notion-token";
const NOTION_VERSION = "2026-03-11";

let http;
let errorSpy;

beforeEach(() => {
  http = createFetchMock();
  http.install();
  vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  http.assertAllConsumed();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (call) => JSON.parse(call.body);

/** Minimal in-memory stand-in for the DATABASE_IDS KV namespace */
function makeEnv(store = {}) {
  return {
    DATABASE_IDS: {
      list: vi.fn(async () => ({ keys: Object.keys(store).map((name) => ({ name })) })),
      get: vi.fn(async (key) => store[key] ?? null),
      put: vi.fn(async (key, value) => {
        store[key] = value;
      }),
    },
    store,
  };
}

/** Asserts the standard Notion headers were sent */
function expectNotionHeaders(call) {
  expect(call.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  expect(call.headers.get("notion-version")).toBe(NOTION_VERSION);
}

// =============================================================================
// getTrackedDatabasesN
// =============================================================================
describe("getTrackedDatabasesN", () => {
  it("returns the keys stored in the KV namespace", async () => {
    const env = makeEnv({ clients: "ds-1", contacts: "ds-2" });

    const keys = await getTrackedDatabasesN(env);

    expect(keys).toEqual([{ name: "clients" }, { name: "contacts" }]);
  });

  it("returns an empty list when nothing is tracked", async () => {
    expect(await getTrackedDatabasesN(makeEnv())).toEqual([]);
  });
});

// =============================================================================
// trackNewDatabaseN
// =============================================================================
describe("trackNewDatabaseN", () => {
  it("stores the first data source id under the given key", async () => {
    const env = makeEnv();
    http.on("GET", `${N}/databases/db-1`, [ok({ data_sources: [{ id: "ds-9" }, { id: "ds-10" }] })]);

    const result = await trackNewDatabaseN(TOKEN, env, "clients", "db-1");

    expect(result).toBe(true);
    expect(env.DATABASE_IDS.put).toHaveBeenCalledWith("clients", "ds-9");
    expectNotionHeaders(http.calls[0]);
  });

  it("overwrites an existing key", async () => {
    const env = makeEnv({ clients: "old-id" });
    http.on("GET", `${N}/databases/db-1`, [ok({ data_sources: [{ id: "ds-new" }] })]);

    await trackNewDatabaseN(TOKEN, env, "clients", "db-1");

    expect(env.store.clients).toBe("ds-new");
  });

  it("returns false and stores nothing when Notion rejects the request", async () => {
    const env = makeEnv();
    http.on("GET", `${N}/databases/db-1`, [reply(404)]);

    const result = await trackNewDatabaseN(TOKEN, env, "clients", "db-1");

    expect(result).toBe(false);
    expect(env.DATABASE_IDS.put).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("throws when the database has no data sources (current behaviour)", async () => {
    const env = makeEnv();
    http.on("GET", `${N}/databases/db-1`, [ok({})]);

    await expect(trackNewDatabaseN(TOKEN, env, "clients", "db-1")).rejects.toThrow(TypeError);
    expect(env.DATABASE_IDS.put).not.toHaveBeenCalled();
  });
});

// =============================================================================
// getDatabaseIdN
// =============================================================================
describe("getDatabaseIdN", () => {
  it("returns the stored id", async () => {
    expect(await getDatabaseIdN(makeEnv({ clients: "ds-1" }), "clients")).toBe("ds-1");
  });

  it("returns false for an unknown key", async () => {
    expect(await getDatabaseIdN(makeEnv(), "missing")).toBe(false);
  });

  it("returns false for an empty stored value", async () => {
    expect(await getDatabaseIdN(makeEnv({ clients: "" }), "clients")).toBe(false);
  });
});

// =============================================================================
// getDatabaseSchemaN
// =============================================================================
describe("getDatabaseSchemaN", () => {
  it("returns the schema properties", async () => {
    const properties = { Name: { type: "title" }, Email: { type: "email" } };
    http.on("GET", `${N}/data_sources/ds-1`, [ok({ properties })]);

    const result = await getDatabaseSchemaN(TOKEN, "ds-1");

    expect(result).toEqual({ status: 200, message: "Database schema found.", schema: properties });
    expectNotionHeaders(http.calls[0]);
  });

  it("passes through a failing status", async () => {
    http.on("GET", `${N}/data_sources/ds-1`, [reply(404)]);

    expect(await getDatabaseSchemaN(TOKEN, "ds-1")).toEqual({
      status: 404,
      message: "Failed to get database Schema",
    });
  });

  it("returns 500 when the response has no properties", async () => {
    http.on("GET", `${N}/data_sources/ds-1`, [ok({})]);

    expect(await getDatabaseSchemaN(TOKEN, "ds-1")).toEqual({
      status: 500,
      message: "Database found but schema is missing",
    });
  });
});

// =============================================================================
// uploadFileN
// =============================================================================
describe("uploadFileN", () => {
  const pdf = () => new File(["%PDF"], "cv.pdf", { type: "application/pdf" });

  describe("method: file", () => {
    it.each([
      ["undefined", undefined],
      ["null", null],
      ["a string", "https://example.com/cv.pdf"],
      ["a plain object", { name: "cv.pdf" }],
    ])("returns 400 when the file is %s, without calling Notion", async (_label, bad) => {
      const result = await uploadFileN(TOKEN, bad, "cv.pdf", "file");

      expect(result).toEqual({ status: 400, message: "File missing or malformed." });
      expect(http.calls).toHaveLength(0);
    });

    it("creates the upload, sends the file, and returns the upload id", async () => {
      http.on("POST", `${N}/file_uploads`, [ok({ id: "up-1" })]);
      http.on("POST", `${N}/file_uploads/up-1/send`, [ok()]);

      const result = await uploadFileN(TOKEN, pdf(), "cv.pdf", "file");

      expect(result).toEqual({ status: 200, message: "File uploaded successfully", id: "up-1" });

      const [create, send] = http.calls;
      expect(json(create)).toEqual({
        mode: "single_part",
        filename: "cv.pdf",
        content_type: "application/pdf",
      });
      expectNotionHeaders(create);
      expectNotionHeaders(send);
      expect(send.body).toBeInstanceOf(FormData);
      expect(send.body.get("file").name).toBe("cv.pdf");
    });

    it("passes through a failure to create the upload", async () => {
      http.on("POST", `${N}/file_uploads`, [reply(401)]);

      expect(await uploadFileN(TOKEN, pdf(), "cv.pdf", "file")).toEqual({
        status: 401,
        message: "Failed to create File Upload",
      });
    });

    it("returns 500 when Notion doesn't return an upload id", async () => {
      http.on("POST", `${N}/file_uploads`, [ok({})]);

      expect(await uploadFileN(TOKEN, pdf(), "cv.pdf", "file")).toEqual({
        status: 500,
        message: "Couldn't get file upload ID",
      });
    });

    it("passes through a failure to send the file data", async () => {
      http.on("POST", `${N}/file_uploads`, [ok({ id: "up-1" })]);
      http.on("POST", `${N}/file_uploads/up-1/send`, [reply(413)]);

      expect(await uploadFileN(TOKEN, pdf(), "cv.pdf", "file")).toEqual({
        status: 413,
        message: "Failed to upload file",
      });
    });
  });

  describe("method: link", () => {
    const url = "https://example.com/files/cv.pdf";

    it("registers the external URL and returns the upload id", async () => {
      http.on("POST", `${N}/file_uploads`, [ok({ id: "up-2" })]);

      const result = await uploadFileN(TOKEN, url, "cv.pdf", "link");

      expect(result).toEqual({ status: 200, message: "File uploaded successfully", id: "up-2" });
      expect(json(http.calls[0])).toEqual({
        mode: "external_url",
        filename: "cv.pdf",
        content_type: "application/octet-stream",
        external_url: url,
      });
      expectNotionHeaders(http.calls[0]);
      expect(http.calls).toHaveLength(1); // no separate "send" step for links
    });

    it("passes through a failure to create the upload", async () => {
      http.on("POST", `${N}/file_uploads`, [reply(400)]);

      expect(await uploadFileN(TOKEN, url, "cv.pdf", "link")).toEqual({
        status: 400,
        message: "Failed to create File Upload",
      });
    });

    it("returns 500 when Notion doesn't return an upload id", async () => {
      http.on("POST", `${N}/file_uploads`, [ok({})]);

      expect(await uploadFileN(TOKEN, url, "cv.pdf", "link")).toEqual({
        status: 500,
        message: "Couldn't get file upload ID",
      });
    });
  });
});

// =============================================================================
// addRecordN
// =============================================================================
describe("addRecordN", () => {
  const properties = { Name: { title: [{ text: { content: "Acme" } }] } };

  it("creates a page under the data source with the given properties", async () => {
    http.on("POST", `${N}/pages`, [ok({ id: "page-1" })]);

    const result = await addRecordN(TOKEN, "ds-1", properties);

    expect(result).toEqual({ status: 200, message: "Record created successfully" });
    const [call] = http.calls;
    expect(json(call)).toEqual({
      parent: { type: "data_source_id", data_source_id: "ds-1" },
      properties,
    });
    expectNotionHeaders(call);
    expect(call.headers.get("content-type")).toBe("application/json");
  });

  it.each([400, 401, 404, 429, 500])("passes through a failing status (%i)", async (status) => {
    http.on("POST", `${N}/pages`, [reply(status)]);

    expect(await addRecordN(TOKEN, "ds-1", properties)).toEqual({
      status,
      message: "Failed to create new record",
    });
  });
});

// =============================================================================
// updateRecordN
// =============================================================================
describe("updateRecordN", () => {
  const update = { Status: { select: { name: "Contacted" } } };

  it("PATCHes the page with the given properties", async () => {
    http.on("PATCH", `${N}/pages/page-1`, [ok()]);

    const result = await updateRecordN(TOKEN, "page-1", update);

    expect(result).toEqual({ status: 200, message: "Record updated successfully" });
    const [call] = http.calls;
    expect(json(call)).toEqual({ properties: update });
    expectNotionHeaders(call);
  });

  it.each([400, 404, 409, 500])("passes through a failing status (%i)", async (status) => {
    http.on("PATCH", `${N}/pages/page-1`, [reply(status)]);

    expect(await updateRecordN(TOKEN, "page-1", update)).toEqual({
      status,
      message: "Failed to update record",
    });
  });
});

// =============================================================================
// getFilteredRecordsN
// =============================================================================
describe("getFilteredRecordsN", () => {
  const filter = { property: "Status", select: { equals: "New" } };
  const sorts = [{ property: "Created", direction: "descending" }];
  const queryUrl = `${N}/data_sources/ds-1/query`;

  it("returns the results of a single page", async () => {
    http.on("POST", queryUrl, [ok({ results: [{ id: "a" }, { id: "b" }], has_more: false })]);

    const result = await getFilteredRecordsN(TOKEN, "ds-1", filter, sorts);

    expect(result).toEqual({
      status: 200,
      message: "Records found successfully",
      results: [{ id: "a" }, { id: "b" }],
    });
  });

  it("sends the filter, sorts, page size and archive flag", async () => {
    http.on("POST", queryUrl, [ok({ results: [], has_more: false })]);

    await getFilteredRecordsN(TOKEN, "ds-1", filter, sorts);

    const [call] = http.calls;
    expect(json(call)).toEqual({ sorts, filter, page_size: 100, is_archived: false });
    expectNotionHeaders(call);
  });

  it("follows pagination cursors and combines all pages in order", async () => {
    http.on("POST", queryUrl, [
      ok({ results: [{ id: "a" }], has_more: true, next_cursor: "cur-2" }),
      ok({ results: [{ id: "b" }], has_more: true, next_cursor: "cur-3" }),
      ok({ results: [{ id: "c" }], has_more: false, next_cursor: null }),
    ]);

    const result = await getFilteredRecordsN(TOKEN, "ds-1", filter, sorts);

    expect(result.results).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(http.calls).toHaveLength(3);
    expect(json(http.calls[0]).start_cursor).toBeUndefined();
    expect(json(http.calls[1]).start_cursor).toBe("cur-2");
    expect(json(http.calls[2]).start_cursor).toBe("cur-3");
  });

  it("returns an empty result list when nothing matches", async () => {
    http.on("POST", queryUrl, [ok({ results: [], has_more: false })]);

    const result = await getFilteredRecordsN(TOKEN, "ds-1", filter, sorts);

    expect(result).toEqual({ status: 200, message: "Records found successfully", results: [] });
  });

  it("passes through a failing status", async () => {
    http.on("POST", queryUrl, [reply(400, { message: "bad filter" })]);

    expect(await getFilteredRecordsN(TOKEN, "ds-1", filter, sorts)).toEqual({
      status: 400,
      message: "Failed to query database",
    });
  });

  it("fails the whole query (no partial results) if a later page errors", async () => {
    http.on("POST", queryUrl, [
      ok({ results: [{ id: "a" }], has_more: true, next_cursor: "cur-2" }),
      reply(500),
    ]);

    const result = await getFilteredRecordsN(TOKEN, "ds-1", filter, sorts);

    expect(result).toEqual({ status: 500, message: "Failed to query database" });
    expect(result.results).toBeUndefined();
  });
});