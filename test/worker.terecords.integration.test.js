import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Integration tests for the Top Echelon record endpoints:
// /query-te, /add-record-te and /update-record-te.
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
import { getAccessTokenTE } from "../src/authenticate.js";
import { retryTimer } from "../src/utilities.js";
import { createFetchMock, ok, reply, makeWorkerEnv, makeRequest } from "./helpers.js";

const TE = "https://bb3api.topechelon.com/public/v1";

let http;
let env;

const call = (path, opts) => worker.fetch(makeRequest(path, opts), env, {});
/** POST a JSON body (a string body is sent raw, for malformed-JSON tests) */
const post = (path, json, opts = {}) => call(path, { method: "POST", json, ...opts });
const jsonBody = (c) => JSON.parse(c.body);

beforeEach(() => {
  http = createFetchMock();
  http.install();
  env = makeWorkerEnv({ userId: "user-1" });

  getAccessTokenTE.mockReset().mockResolvedValue("te-token");
  retryTimer.mockReset().mockResolvedValue(undefined);

  for (const m of ["log", "warn", "error"]) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
  http.assertAllConsumed();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Mock "this hotlist exists" for the hotlist name search */
function mockHotlistExists(name, id = "hl-1") {
  http.on("GET", `${TE}/hotlists`, [ok({ metadata: { resultset: { count: 1 } }, results: [{ id }] })], {
    record_type: "person",
    name,
    page: "1",
  });
}

/** Mock the add_record call that puts a person into a hotlist */
function mockAddToHotlist(hotlistId, recordId, responses = [ok()]) {
  http.on("POST", `${TE}/hotlists/${hotlistId}/add_record`, responses, { record_id: String(recordId) });
}

const hotlistCalls = () => http.calls.filter((c) => c.url.pathname.includes("/hotlists"));

// =============================================================================
// Behaviour common to the three endpoints
// =============================================================================
describe.each(["/query-te", "/add-record-te", "/update-record-te"])("%s (common behaviour)", (path) => {
  it("returns 405 for non-POST methods without touching Top Echelon", async () => {
    const res = await call(path, { method: "GET" });

    expect(res.status).toBe(405);
    expect(await res.text()).toBe("Method not allowed");
    expect(http.calls).toHaveLength(0);
    expect(getAccessTokenTE).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed JSON body", async () => {
    const res = await post(path, "{not json");

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Body must be a JSON object");
    expect(http.calls).toHaveLength(0);
  });

  it.each([["an array", []], ["a string", "text"], ["null", null], ["a number", 5]])(
    "returns 400 when the body is %s",
    async (_label, body) => {
      const res = await post(path, JSON.stringify(body));

      expect(res.status).toBe(400);
      expect(await res.text()).toBe("Body must be a JSON object");
    }
  );

  it("doesn't check the Origin header (same as the Notion endpoints)", async () => {
    // Documents current behaviour: a request from anywhere gets past the origin stage.
    // An empty body proves it got as far as input validation (400) rather than 403.
    const res = await post(path, {}, { origin: "https://evil.example.com" });

    expect(res.status).toBe(400);
  });
});

// =============================================================================
// /query-te
// =============================================================================
describe("/query-te", () => {
  const filter = { keyword: "Jane Doe", minimum_date_modified: "2026-10-01" };
  const searchUrl = `${TE}/people/search`;
  const page = (n, totalPages, entries) =>
    ok({ pagination: { current_page: n, total_pages: totalPages, total_count: 99 }, entries });

  it("returns the matching records as JSON", async () => {
    http.on("POST", searchUrl, [page(1, 1, [{ id: 1, name: "Jane Doe" }, { id: 2, name: "Jane Doe" }])]);

    const res = await post("/query-te", { filter });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual([{ id: 1, name: "Jane Doe" }, { id: 2, name: "Jane Doe" }]);
    expect(getAccessTokenTE).toHaveBeenCalledWith(env, "user-1");
  });

  it("sends the filter as person_search with the default sort, and the bearer token", async () => {
    http.on("POST", searchUrl, [page(1, 1, [])]);

    await post("/query-te", { filter });

    const [c] = http.calls;
    expect(jsonBody(c)).toEqual({ page: 1, sort_by: "date_added", sort_order: "desc", person_search: filter });
    expect(c.headers.get("authorization")).toBe("Bearer te-token");
  });

  it("passes a custom sort through", async () => {
    http.on("POST", searchUrl, [page(1, 1, [])]);

    await post("/query-te", { filter, sort_by: "last_name", sort_order: "asc" });

    expect(jsonBody(http.calls[0])).toMatchObject({ sort_by: "last_name", sort_order: "asc" });
  });

  it("accepts an empty filter object (matches everyone)", async () => {
    http.on("POST", searchUrl, [page(1, 1, [{ id: 1 }])]);

    const res = await post("/query-te", { filter: {} });

    expect(res.status).toBe(200);
    expect(jsonBody(http.calls[0]).person_search).toEqual({});
  });

  it("returns every page of results, in order", async () => {
    http.on("POST", searchUrl, [page(1, 3, [{ id: 1 }]), page(2, 3, [{ id: 2 }]), page(3, 3, [{ id: 3 }])]);

    const res = await post("/query-te", { filter });

    expect(await res.json()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(http.calls.map((c) => jsonBody(c).page)).toEqual([1, 2, 3]);
    expect(res.headers.get("x-results-truncated")).toBeNull();
  });

  it("returns an empty list (200) when nothing matches", async () => {
    http.on("POST", searchUrl, [page(1, 0, [])]);

    const res = await post("/query-te", { filter });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("doesn't wait before searching (unlike the resume-parsing lookup)", async () => {
    http.on("POST", searchUrl, [page(1, 1, [{ id: 1 }])]);

    await post("/query-te", { filter });

    expect(retryTimer).not.toHaveBeenCalled();
  });

  it("stops at the page limit and flags the truncation in a header", async () => {
    // 20 pages are fetched; a 21st would hit an unmocked request and fail the test
    http.on(
      "POST",
      searchUrl,
      Array.from({ length: 20 }, (_, i) => page(i + 1, 25, [{ id: i + 1 }]))
    );

    const res = await post("/query-te", { filter });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-results-truncated")).toBe("true");
    expect(await res.json()).toHaveLength(20);
  });

  it("waits for Retry-After on a 429, then continues", async () => {
    http.on("POST", searchUrl, [reply(429, {}, { "Retry-After": "2" }), page(1, 1, [{ id: 1 }])]);

    const res = await post("/query-te", { filter });

    expect(res.status).toBe(200);
    expect(retryTimer).toHaveBeenCalledWith("2");
    expect(await res.json()).toEqual([{ id: 1 }]);
  });

  it("returns 500 'Too many retries' after repeated 429s", async () => {
    http.on("POST", searchUrl, [reply(429), reply(429), reply(429), reply(429)]);

    const res = await post("/query-te", { filter });

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Too many retries");
  });

  it("returns 500 when the retry timer is unusable", async () => {
    http.on("POST", searchUrl, [reply(429, {}, { "Retry-After": "99999" })]);
    retryTimer.mockReturnValueOnce(null);

    const res = await post("/query-te", { filter });

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Retry timer broken or too long");
  });

  it("returns 500 on an authentication error", async () => {
    http.on("POST", searchUrl, [reply(401)]);

    const res = await post("/query-te", { filter });

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Authentication error");
  });

  it.each([400, 403, 500])("returns 500 when Top Echelon responds %i", async (status) => {
    http.on("POST", searchUrl, [reply(status)]);

    const res = await post("/query-te", { filter });

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Failed to search records");
  });

  it("returns 500 with no partial results if a later page fails", async () => {
    http.on("POST", searchUrl, [page(1, 2, [{ id: 1 }]), reply(500)]);

    const res = await post("/query-te", { filter });

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Failed to search records");
  });

  describe("input validation (no request reaches Top Echelon)", () => {
    it.each([
      ["filter missing", {}, "Filter not specified"],
      ["filter empty string", { filter: "" }, "Filter not specified"],
      ["filter a string", { filter: "Jane" }, "Filter must be an object"],
      ["filter an array", { filter: [1] }, "Filter must be an object"],
      ["sort_by empty", { filter, sort_by: "" }, "sort_by must be a non-empty string"],
      ["sort_by a number", { filter, sort_by: 5 }, "sort_by must be a non-empty string"],
      ["sort_order invalid", { filter, sort_order: "up" }, "sort_order must be 'asc' or 'desc'"],
      ["sort_order uppercase", { filter, sort_order: "ASC" }, "sort_order must be 'asc' or 'desc'"],
    ])("returns 400 when %s", async (_label, body, message) => {
      const res = await post("/query-te", body);

      expect(res.status).toBe(400);
      expect(await res.text()).toBe(message);
      expect(http.calls).toHaveLength(0);
      expect(getAccessTokenTE).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// /add-record-te
// =============================================================================
describe("/add-record-te", () => {
  const properties = {
    first_name: "Jane",
    last_name: "Doe",
    email_addresses_attributes: [{ primary: true, type: "work", email: "jane@example.com" }],
  };
  const createUrl = `${TE}/people`;

  it("creates the record and returns its id", async () => {
    http.on("POST", createUrl, [reply(201, { person: { id: 321 } })]);

    const res = await post("/add-record-te", { properties });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ message: "Record Added Successfully", id: 321 });
  });

  it("sends the properties wrapped in `person`, with the bearer token", async () => {
    http.on("POST", createUrl, [reply(201, { person: { id: 321 } })]);

    await post("/add-record-te", { properties });

    const [c] = http.calls;
    expect(jsonBody(c)).toEqual({ person: properties });
    expect(c.headers.get("authorization")).toBe("Bearer te-token");
    expect(c.headers.get("content-type")).toBe("application/json");
  });

  it("never sends the hotlist field to Top Echelon as part of the person", async () => {
    http.on("POST", createUrl, [reply(201, { person: { id: 321 } })]);
    mockHotlistExists("VIP List");
    mockAddToHotlist("hl-1", 321);

    await post("/add-record-te", { properties, hotlist: "VIP List" });

    expect(jsonBody(http.calls[0])).toEqual({ person: properties });
  });

  it("accepts a 200 from Top Echelon and an id at the top level of the response", async () => {
    http.on("POST", createUrl, [reply(200, { id: 555 })]);

    const res = await post("/add-record-te", { properties });

    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(555);
  });

  describe("with a hotlist", () => {
    it("adds the new record to an existing hotlist", async () => {
      http.on("POST", createUrl, [reply(201, { person: { id: 321 } })]);
      mockHotlistExists("VIP List");
      mockAddToHotlist("hl-1", 321);

      const res = await post("/add-record-te", { properties, hotlist: "VIP List" });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Record Added Successfully", id: 321, hotlist: "VIP List" });
      expect(http.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
        "POST /public/v1/people",
        "GET /public/v1/hotlists",
        "POST /public/v1/hotlists/hl-1/add_record",
      ]);
    });

    it("creates the hotlist first if it doesn't exist", async () => {
      http.on("POST", createUrl, [reply(201, { person: { id: 321 } })]);
      http.on("GET", `${TE}/hotlists`, [ok({ metadata: { resultset: { count: 0 } }, results: [] })]);
      http.on("POST", `${TE}/hotlists`, [reply(201, { hotlist: { id: "hl-new" } })], { record_type: "person" });
      mockAddToHotlist("hl-new", 321);

      const res = await post("/add-record-te", { properties, hotlist: "Brand New" });

      expect(res.status).toBe(200);
      const [create] = http.callsTo("POST", "/public/v1/hotlists");
      expect(jsonBody(create).hotlist.name).toBe("Brand New");
    });

    it.each([["null", null], ["an empty string", ""]])("treats %s as no hotlist", async (_label, hotlist) => {
      http.on("POST", createUrl, [reply(201, { person: { id: 321 } })]);

      const res = await post("/add-record-te", { properties, hotlist });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Record Added Successfully", id: 321 });
      expect(hotlistCalls()).toHaveLength(0);
    });

    it("returns 500 naming the new record's id when the hotlist can't be found or created", async () => {
      http.on("POST", createUrl, [reply(201, { person: { id: 321 } })]);
      http.on("GET", `${TE}/hotlists`, [reply(500)]);

      const res = await post("/add-record-te", { properties, hotlist: "VIP List" });

      expect(res.status).toBe(500);
      expect(await res.text()).toBe(
        "Record added (id: 321) but could not be added to hotlist: Hotlist could not be found or created"
      );
    });

    it("returns 500 naming the new record's id when Top Echelon rejects the hotlist add (401)", async () => {
      http.on("POST", createUrl, [reply(201, { person: { id: 321 } })]);
      mockHotlistExists("VIP List");
      mockAddToHotlist("hl-1", 321, [reply(401)]);

      const res = await post("/add-record-te", { properties, hotlist: "VIP List" });

      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Record added (id: 321) but could not be added to hotlist: Authentication error");
    });
  });

  describe("when Top Echelon fails", () => {
    it.each([400, 401, 422, 500])("returns 500 when creating the record responds %i", async (status) => {
      http.on("POST", createUrl, [reply(status)]);

      const res = await post("/add-record-te", { properties, hotlist: "VIP List" });

      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Failed to create new record");
      expect(hotlistCalls()).toHaveLength(0); // never touches the hotlist for a record that wasn't created
    });

    it("returns 500 if the response doesn't contain the new record's id", async () => {
      http.on("POST", createUrl, [reply(201, {})]);

      const res = await post("/add-record-te", { properties });

      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Record was created but its id could not be read from the response");
    });
  });

  describe("input validation (no request reaches Top Echelon)", () => {
    it.each([
      ["properties missing", {}, "Record properties missing"],
      ["properties null", { properties: null }, "Record properties missing"],
      ["properties a string", { properties: "Jane" }, "Record properties must be an object"],
      ["properties an array", { properties: [1] }, "Record properties must be an object"],
      ["hotlist a number", { properties, hotlist: 5 }, "Hotlist must be a non-empty string"],
      ["hotlist an object", { properties, hotlist: {} }, "Hotlist must be a non-empty string"],
      ["hotlist only spaces", { properties, hotlist: "   " }, "Hotlist must be a non-empty string"],
      ["hotlist containing &", { properties, hotlist: "R&D" }, "Hotlist name can't contain & # % + or ?"],
      ["hotlist containing #", { properties, hotlist: "Top #1" }, "Hotlist name can't contain & # % + or ?"],
      ["hotlist containing ?", { properties, hotlist: "Who?" }, "Hotlist name can't contain & # % + or ?"],
    ])("returns 400 when %s", async (_label, body, message) => {
      const res = await post("/add-record-te", body);

      expect(res.status).toBe(400);
      expect(await res.text()).toBe(message);
      expect(http.calls).toHaveLength(0);
      expect(getAccessTokenTE).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// /update-record-te
// =============================================================================
describe("/update-record-te", () => {
  const properties = { city: "Austin", state: "TX" };
  const updateUrl = `${TE}/people/99`;

  it("updates the record and returns its id", async () => {
    http.on("PUT", updateUrl, [ok()]);

    const res = await post("/update-record-te", { record: "99", properties });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ message: "Record Updated Successfully", id: "99" });
  });

  it("sends the properties wrapped in `person` with a PUT, and the bearer token", async () => {
    http.on("PUT", updateUrl, [ok()]);

    await post("/update-record-te", { record: "99", properties });

    const [c] = http.calls;
    expect(c.method).toBe("PUT");
    expect(jsonBody(c)).toEqual({ person: properties });
    expect(c.headers.get("authorization")).toBe("Bearer te-token");
  });

  it("accepts a numeric record id", async () => {
    http.on("PUT", updateUrl, [ok()]);

    const res = await post("/update-record-te", { record: 99, properties });

    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe("99");
  });

  it("doesn't make any hotlist calls when no hotlist is given", async () => {
    http.on("PUT", updateUrl, [ok()]);

    await post("/update-record-te", { record: "99", properties });

    expect(hotlistCalls()).toHaveLength(0);
  });

  describe("with a hotlist", () => {
    it("adds the updated record to the hotlist", async () => {
      http.on("PUT", updateUrl, [ok()]);
      mockHotlistExists("Follow Up");
      mockAddToHotlist("hl-1", 99);

      const res = await post("/update-record-te", { record: "99", properties, hotlist: "Follow Up" });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Record Updated Successfully", id: "99", hotlist: "Follow Up" });
      expect(http.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
        "PUT /public/v1/people/99",
        "GET /public/v1/hotlists",
        "POST /public/v1/hotlists/hl-1/add_record",
      ]);
    });

    it("never sends the hotlist field to Top Echelon as part of the person", async () => {
      http.on("PUT", updateUrl, [ok()]);
      mockHotlistExists("Follow Up");
      mockAddToHotlist("hl-1", 99);

      await post("/update-record-te", { record: "99", properties, hotlist: "Follow Up" });

      expect(jsonBody(http.calls[0])).toEqual({ person: properties });
    });

    it("treats an empty hotlist as none", async () => {
      http.on("PUT", updateUrl, [ok()]);

      const res = await post("/update-record-te", { record: "99", properties, hotlist: "" });

      expect(res.status).toBe(200);
      expect(hotlistCalls()).toHaveLength(0);
    });

    it("returns 500 saying the record WAS updated when the hotlist step fails", async () => {
      http.on("PUT", updateUrl, [ok()]);
      http.on("GET", `${TE}/hotlists`, [reply(500)]);

      const res = await post("/update-record-te", { record: "99", properties, hotlist: "Follow Up" });

      expect(res.status).toBe(500);
      expect(await res.text()).toBe(
        "Record updated but could not be added to hotlist: Hotlist could not be found or created"
      );
    });
  });

  describe("when Top Echelon fails", () => {
    it.each([400, 404, 422, 500])("returns 500 when the update responds %i", async (status) => {
      http.on("PUT", updateUrl, [reply(status)]);

      const res = await post("/update-record-te", { record: "99", properties, hotlist: "Follow Up" });

      expect(res.status).toBe(500);
      expect(await res.text()).toBe(`Failed to update record (Top Echelon responded ${status})`);
      expect(hotlistCalls()).toHaveLength(0); // never touches the hotlist when the update failed
    });
  });

  describe("input validation (no request reaches Top Echelon)", () => {
    it.each([
      ["record missing", { properties }, "Record not specified"],
      ["record empty", { record: "", properties }, "Record not specified"],
      ["record contains a path", { record: "99/attachments", properties }, "Record id is malformed"],
      ["record contains dots", { record: "../people", properties }, "Record id is malformed"],
      ["record contains a query", { record: "99?x=1", properties }, "Record id is malformed"],
      ["record an object", { record: { id: 99 }, properties }, "Record id is malformed"],
      ["properties missing", { record: "99" }, "Update properties missing"],
      ["properties a string", { record: "99", properties: "city" }, "Update properties must be an object"],
      ["properties an array", { record: "99", properties: [1] }, "Update properties must be an object"],
      ["hotlist a number", { record: "99", properties, hotlist: 5 }, "Hotlist must be a non-empty string"],
      ["hotlist containing &", { record: "99", properties, hotlist: "R&D" }, "Hotlist name can't contain & # % + or ?"],
    ])("returns 400 when %s", async (_label, body, message) => {
      const res = await post("/update-record-te", body);

      expect(res.status).toBe(400);
      expect(await res.text()).toBe(message);
      expect(http.calls).toHaveLength(0);
      expect(getAccessTokenTE).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// Unexpected failures
// =============================================================================
describe("unexpected failures", () => {
  it.each([
    ["/query-te", { filter: { keyword: "x" } }],
    ["/add-record-te", { properties: { first_name: "x" } }],
    ["/update-record-te", { record: "99", properties: { city: "x" } }],
  ])("%s returns the generic 500 with CORS headers if the token lookup throws", async (path, body) => {
    getAccessTokenTE.mockRejectedValue(new Error("KV down"));

    const res = await post(path, body);

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Server Error");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://www.hrtalentalliance.com");
  });
});