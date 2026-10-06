import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Integration tests for the Notion endpoints.
// Real: worker.js and database-actions.js, plus the HTTP requests they make (mocked fetch).
// Mocked: authenticate.js (token lookup), admin.js and utilities.js.
vi.mock("../src/authenticate.js", () => ({
  getAccessTokenTE: vi.fn(),
  newAccessTokenTE: vi.fn(),
  getAccessTokenN: vi.fn(),
  updateAccessTokenN: vi.fn(),
}));
vi.mock("../src/admin.js", () => ({ findDuplicatesTE: vi.fn() }));
vi.mock("../src/utilities.js", () => ({
  uid: vi.fn(),
  getDateString: vi.fn(),
  retryTimer: vi.fn(),
}));

import worker from "../src/worker.js";
import { getAccessTokenN } from "../src/authenticate.js";
import { createFetchMock, ok, reply, makeWorkerEnv, makeRequest } from "./helpers.js";

const N = "https://api.notion.com/v1";

let http;
let env;

const call = (path, opts) => worker.fetch(makeRequest(path, opts), env, {});
/** POST a JSON body (a string body is sent raw, for malformed-JSON tests) */
const post = (path, json, opts = {}) => call(path, { method: "POST", json, ...opts });
const jsonBody = (c) => JSON.parse(c.body);

beforeEach(() => {
  http = createFetchMock();
  http.install();
  // "clients" is a tracked database whose Notion data source id is ds-1
  env = makeWorkerEnv({ userId: "user-1", store: { clients: "ds-1" } });

  getAccessTokenN.mockReset().mockResolvedValue("notion-token");

  for (const m of ["log", "warn", "error"]) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
  http.assertAllConsumed();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Every Notion request must carry the token from authenticate.js */
function expectNotionAuth(c) {
  expect(c.headers.get("authorization")).toBe("Bearer notion-token");
}

// =============================================================================
// Behaviour common to the POST-only endpoints
// =============================================================================
describe.each([
  "/track-new-database",
  "/query-notion",
  "/get-schema",
  "/upload-file-notion",
  "/add-record-notion",
  "/update-record-notion",
])("%s (common behaviour)", (path) => {
  it("returns 405 for non-POST methods", async () => {
    const res = await call(path, { method: "GET" });

    expect(res.status).toBe(405);
    expect(await res.text()).toBe("Method not allowed");
    expect(http.calls).toHaveLength(0);
  });

  it("returns a 500 'Server Error' for a malformed JSON body (current behaviour)", async () => {
    const res = await post(path, "{not json");

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Server Error");
  });
});

// =============================================================================
// /get-tracked-databases
// =============================================================================
describe("/get-tracked-databases", () => {
  it("lists the names of the tracked databases", async () => {
    env = makeWorkerEnv({ store: { clients: "ds-1", contacts: "ds-2", jobs: "ds-3" } });

    const res = await call("/get-tracked-databases");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(["clients", "contacts", "jobs"]);
  });

  it("returns an empty list when nothing is tracked", async () => {
    env = makeWorkerEnv();

    const res = await call("/get-tracked-databases");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

// =============================================================================
// /track-new-database
// =============================================================================
describe("/track-new-database", () => {
  const link = "https://app.notion.com/p/abc123def?v=view1";

  it("tracks the database and stores its data source id under the given name", async () => {
    http.on("GET", `${N}/databases/abc123def`, [ok({ data_sources: [{ id: "ds-77" }] })]);

    const res = await post("/track-new-database", { name: "leads", link });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Database tracked");
    expect(env.store.leads).toBe("ds-77");
    expectNotionAuth(http.calls[0]);
  });

  it("returns 500 and stores nothing when Notion can't find the database", async () => {
    http.on("GET", `${N}/databases/abc123def`, [reply(404)]);

    const res = await post("/track-new-database", { name: "leads", link });

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Error tracking database");
    expect(env.store).not.toHaveProperty("leads");
  });

  it.each([
    ["name missing", { link }],
    ["link missing", { name: "leads" }],
    ["empty body", {}],
  ])("returns 400 when %s", async (_label, body) => {
    const res = await post("/track-new-database", body);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Malformed input");
    expect(http.calls).toHaveLength(0);
  });

  it.each([
    "https://www.notion.so/abc123def",
    "https://example.com/p/abc123def",
    "app.notion.com/p/abc123def",
  ])("returns 400 for a link that isn't a Notion share link (%s)", async (badLink) => {
    const res = await post("/track-new-database", { name: "leads", link: badLink });

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Must include share link");
    expect(http.calls).toHaveLength(0);
  });
});

// =============================================================================
// /query-notion
// =============================================================================
describe("/query-notion", () => {
  const filter = { property: "Status", select: { equals: "New" } };
  const sort = { property: "Created", direction: "descending" };
  const input = { database: "clients", filter, sort };
  const queryUrl = `${N}/data_sources/ds-1/query`;

  it("returns the matching records as JSON", async () => {
    http.on("POST", queryUrl, [ok({ results: [{ id: "a" }, { id: "b" }], has_more: false })]);

    const res = await post("/query-notion", input);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("queries the tracked data source with the filter and a one-item sort list", async () => {
    http.on("POST", queryUrl, [ok({ results: [], has_more: false })]);

    await post("/query-notion", input);

    const [c] = http.calls;
    expect(jsonBody(c)).toMatchObject({ filter, sorts: [sort], page_size: 100, is_archived: false });
    expectNotionAuth(c);
  });

  it("returns every page of results", async () => {
    http.on("POST", queryUrl, [
      ok({ results: [{ id: "a" }], has_more: true, next_cursor: "c2" }),
      ok({ results: [{ id: "b" }], has_more: false }),
    ]);

    const res = await post("/query-notion", input);

    expect(await res.json()).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("returns 500 with Notion's failure message when the query fails", async () => {
    http.on("POST", queryUrl, [reply(400)]);

    const res = await post("/query-notion", input);

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Failed to query database");
  });

  it("returns 404 for a database that isn't tracked", async () => {
    const res = await post("/query-notion", { ...input, database: "unknown" });

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Database not found");
    expect(http.calls).toHaveLength(0);
  });

  it("returns 400 when the database is missing", async () => {
    const res = await post("/query-notion", { filter, sort });

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Database not specified");
  });

  it("returns 400 when the filter is missing", async () => {
    const res = await post("/query-notion", { database: "clients", sort });

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Filter not specified");
  });

  it("returns 400 when the sort is missing", async () => {
    const res = await post("/query-notion", { database: "clients", filter });

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Sort order not specified");
    expect(http.calls).toHaveLength(0);
  });
});

// =============================================================================
// /get-schema
// =============================================================================
describe("/get-schema", () => {
  const schemaUrl = `${N}/data_sources/ds-1`;
  const properties = { Name: { type: "title" }, Email: { type: "email" } };

  it("returns the database schema as JSON", async () => {
    http.on("GET", schemaUrl, [ok({ properties })]);

    const res = await post("/get-schema", { database: "clients" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(properties);
    expectNotionAuth(http.calls[0]);
  });

  it("returns 500 with Notion's failure message when the schema can't be fetched", async () => {
    http.on("GET", schemaUrl, [reply(404)]);

    const res = await post("/get-schema", { database: "clients" });

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Failed to get database Schema");
  });

  it("returns 500 when Notion's response has no schema", async () => {
    http.on("GET", schemaUrl, [ok({})]);

    const res = await post("/get-schema", { database: "clients" });

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Database found but schema is missing");
  });

  it("returns 404 for a database that isn't tracked", async () => {
    const res = await post("/get-schema", { database: "unknown" });

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Database not found");
  });

  it("returns 400 when the database is missing", async () => {
    const res = await post("/get-schema", {});

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Database not specified");
  });
});

// =============================================================================
// /upload-file-notion
// =============================================================================
describe("/upload-file-notion", () => {
  const input = { method: "link", file: "https://example.com/cv.pdf", filename: "cv.pdf" };

  it("registers an external link and returns the upload id", async () => {
    http.on("POST", `${N}/file_uploads`, [ok({ id: "up-1" })]);

    const res = await post("/upload-file-notion", input);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("up-1");
    const [c] = http.calls;
    expect(jsonBody(c)).toEqual({
      mode: "external_url",
      filename: "cv.pdf",
      content_type: "application/octet-stream",
      external_url: "https://example.com/cv.pdf",
    });
    expectNotionAuth(c);
  });

  it("returns 500 with Notion's failure message when the upload can't be created", async () => {
    http.on("POST", `${N}/file_uploads`, [reply(401)]);

    const res = await post("/upload-file-notion", input);

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Failed to create File Upload");
  });

  it("returns 500 when Notion gives back no upload id", async () => {
    http.on("POST", `${N}/file_uploads`, [ok({})]);

    const res = await post("/upload-file-notion", input);

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Couldn't get file upload ID");
  });

  it("can't upload raw files: method 'file' fails because JSON can't carry a File", async () => {
    const res = await post("/upload-file-notion", { ...input, method: "file" });

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("File missing or malformed.");
    expect(http.calls).toHaveLength(0);
  });

  it.each([
    ["method", "Upload method missing"],
    ["file", "File missing"],
    ["filename", "Filename missing"],
  ])("returns 400 when %s is missing", async (field, message) => {
    const { [field]: _removed, ...rest } = input;

    const res = await post("/upload-file-notion", rest);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe(message);
    expect(http.calls).toHaveLength(0);
  });
});

// =============================================================================
// /add-record-notion
// =============================================================================
describe("/add-record-notion", () => {
  const properties = { Name: { title: [{ text: { content: "Acme" } }] } };

  it("creates a record in the tracked database", async () => {
    http.on("POST", `${N}/pages`, [ok({ id: "page-1" })]);

    const res = await post("/add-record-notion", { database: "clients", properties });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Record Added Successfully");
    const [c] = http.calls;
    expect(jsonBody(c)).toEqual({
      parent: { type: "data_source_id", data_source_id: "ds-1" },
      properties,
    });
    expectNotionAuth(c);
  });

  it.each([400, 401, 429, 500])("returns 500 when Notion responds %i", async (status) => {
    http.on("POST", `${N}/pages`, [reply(status)]);

    const res = await post("/add-record-notion", { database: "clients", properties });

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Failed to create new record");
  });

  it("returns 404 for a database that isn't tracked", async () => {
    const res = await post("/add-record-notion", { database: "unknown", properties });

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Database not found");
    expect(http.calls).toHaveLength(0);
  });

  it("returns 400 when the database is missing", async () => {
    const res = await post("/add-record-notion", { properties });

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Database not specified");
  });

  it("returns 400 when the properties are missing", async () => {
    const res = await post("/add-record-notion", { database: "clients" });

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Record properties missing");
  });
});

// =============================================================================
// /update-record-notion
// =============================================================================
describe("/update-record-notion", () => {
  const properties = { Status: { select: { name: "Contacted" } } };

  it("updates the record's properties", async () => {
    http.on("PATCH", `${N}/pages/page-1`, [ok()]);

    const res = await post("/update-record-notion", { record: "page-1", properties });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Record Updated Successfully");
    const [c] = http.calls;
    expect(jsonBody(c)).toEqual({ properties });
    expectNotionAuth(c);
  });

  it.each([400, 404, 409, 500])("returns 500 when Notion responds %i", async (status) => {
    http.on("PATCH", `${N}/pages/page-1`, [reply(status)]);

    const res = await post("/update-record-notion", { record: "page-1", properties });

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Failed to update record");
  });

  it("returns 400 when the record is missing", async () => {
    const res = await post("/update-record-notion", { properties });

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Record not specified");
    expect(http.calls).toHaveLength(0);
  });

  it("returns 400 when the properties are missing", async () => {
    const res = await post("/update-record-notion", { record: "page-1" });

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Update properties missing");
    expect(http.calls).toHaveLength(0);
  });
});