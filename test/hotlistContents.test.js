import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Tests for getHotlistContentsTE (database-actions.js) and the /get-hotlist-te endpoint (worker.js).
// Real: worker.js and database-actions.js, plus the HTTP requests they make (mocked fetch).
// Mocked: authenticate.js, admin.js and utilities.js.
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
import { getHotlistContentsTE } from "../src/database-actions.js";
import { getAccessTokenTE } from "../src/authenticate.js";
import { retryTimer } from "../src/utilities.js";
import { createFetchMock, ok, reply, makeWorkerEnv, makeRequest } from "./helpers.js";

const TE = "https://bb3api.topechelon.com/public/v1";

let http;
let env;

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

/** Mock the hotlist name search */
function mockSearch(name, results, { type = "person", status = 200 } = {}) {
  http.on(
    "GET",
    `${TE}/hotlists`,
    [status === 200 ? ok({ metadata: { resultset: { count: results.length } }, results }) : reply(status)],
    { record_type: type, name, page: "1" }
  );
}
const mockRecords = (id, responses) => http.on("GET", `${TE}/hotlists/${id}/all_records`, responses);
const entry = (id, name = `Person ${id}`) => ({ id, name, type: "person" });

// =============================================================================
// getHotlistContentsTE
// =============================================================================
describe("getHotlistContentsTE", () => {
  it("returns every entry of the hotlist, authenticating both requests", async () => {
    mockSearch("Shortlist", [{ id: "hl-1", name: "Shortlist" }]);
    mockRecords("hl-1", [ok({ entries: [entry("p1"), entry("p2")], pagination: { is_last_page: true } })]);

    const res = await getHotlistContentsTE("tok", "Shortlist");

    expect(res).toEqual({
      status: 200,
      message: "Found Hotlist records",
      results: [entry("p1"), entry("p2")],
      truncated: false,
    });
    expect(http.calls.every((c) => c.headers.get("Authorization") === "Bearer tok")).toBe(true);
  });

  it("never creates a missing hotlist: 404 and no POST", async () => {
    mockSearch("Nope", []);

    const res = await getHotlistContentsTE("tok", "Nope");

    expect(res).toEqual({ status: 404, message: "Hotlist not found" });
    expect(http.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("picks the exact-name hotlist when the search also returns partial matches", async () => {
    mockSearch("Dev", [
      { id: "hl-wrong", name: "Developers" },
      { id: "hl-right", name: "Dev" },
    ]);
    mockRecords("hl-right", [ok({ entries: [entry("p1")] })]);

    const res = await getHotlistContentsTE("tok", "Dev");

    expect(res.status).toBe(200);
    expect(res.results).toEqual([entry("p1")]);
  });

  it("is 404 when only partial matches exist", async () => {
    mockSearch("Dev", [{ id: "hl-wrong", name: "Developers" }]);

    expect((await getHotlistContentsTE("tok", "Dev")).status).toBe(404);
  });

  it("falls back to a case-insensitive match", async () => {
    mockSearch("shortlist", [{ id: "hl-1", name: "Shortlist" }]);
    mockRecords("hl-1", [ok({ entries: [] })]);

    expect((await getHotlistContentsTE("tok", "shortlist")).status).toBe(200);
  });

  it("URL-encodes the hotlist name", async () => {
    mockSearch("R&D #1", [{ id: "hl-1", name: "R&D #1" }]);
    mockRecords("hl-1", [ok({ entries: [] })]);

    const res = await getHotlistContentsTE("tok", "R&D #1");

    expect(res.status).toBe(200);
    expect(http.calls[0].url.href).toContain("name=R%26D%20%231");
  });

  it("searches the requested record type", async () => {
    mockSearch("Job Board", [{ id: "hl-j", name: "Job Board" }], { type: "job" });
    mockRecords("hl-j", [ok({ entries: [] })]);

    expect((await getHotlistContentsTE("tok", "Job Board", "job")).status).toBe(200);
  });

  it("treats an empty hotlist as a success with no results", async () => {
    mockSearch("Empty", [{ id: "hl-1", name: "Empty" }]);
    mockRecords("hl-1", [ok({ entries: [], pagination: { is_last_page: true } })]);

    const res = await getHotlistContentsTE("tok", "Empty");

    expect(res.status).toBe(200);
    expect(res.results).toEqual([]);
  });

  it("tolerates a response with no entries field", async () => {
    mockSearch("X", [{ id: "hl-1", name: "X" }]);
    mockRecords("hl-1", [ok({})]);

    const res = await getHotlistContentsTE("tok", "X");

    expect(res.results).toEqual([]);
    expect(res.truncated).toBe(false);
  });

  it("flags truncation when Top Echelon says there are more pages", async () => {
    mockSearch("Big", [{ id: "hl-1", name: "Big" }]);
    mockRecords("hl-1", [ok({ entries: [entry("p1")], pagination: { is_last_page: false, total_pages: 2 } })]);

    expect((await getHotlistContentsTE("tok", "Big")).truncated).toBe(true);
  });

  it("retries a 429 on the records request, honouring Retry-After", async () => {
    mockSearch("X", [{ id: "hl-1", name: "X" }]);
    mockRecords("hl-1", [reply(429, {}, { "Retry-After": "3" }), ok({ entries: [entry("p1")] })]);

    const res = await getHotlistContentsTE("tok", "X");

    expect(res.status).toBe(200);
    expect(retryTimer).toHaveBeenCalledWith("3");
  });

  it("gives up with 429 after repeated rate limiting", async () => {
    mockSearch("X", [{ id: "hl-1", name: "X" }]);
    mockRecords("hl-1", [reply(429), reply(429), reply(429), reply(429)]);

    const res = await getHotlistContentsTE("tok", "X");

    expect(res).toEqual({ status: 429, message: "Too many retries" });
    expect(http.callsTo("GET", "/public/v1/hotlists/hl-1/all_records")).toHaveLength(4);
  });

  it("stops with 429 when the retry timer is unusable", async () => {
    retryTimer.mockReturnValue(false);
    mockSearch("X", [{ id: "hl-1", name: "X" }]);
    mockRecords("hl-1", [reply(429)]);

    expect(await getHotlistContentsTE("tok", "X")).toEqual({ status: 429, message: "Retry timer broken or too long" });
  });

  it("reports 401 from the hotlist search", async () => {
    mockSearch("X", [], { status: 401 });

    expect(await getHotlistContentsTE("tok", "X")).toEqual({ status: 401, message: "Authentication error" });
  });

  it("reports 401 from the records request", async () => {
    mockSearch("X", [{ id: "hl-1", name: "X" }]);
    mockRecords("hl-1", [reply(401)]);

    expect(await getHotlistContentsTE("tok", "X")).toEqual({ status: 401, message: "Authentication error" });
  });

  it("passes through other failures from the search and the records request", async () => {
    mockSearch("A", [], { status: 500 });
    expect(await getHotlistContentsTE("tok", "A")).toEqual({ status: 500, message: "Failed to search for hotlist" });

    mockSearch("B", [{ id: "hl-1", name: "B" }]);
    mockRecords("hl-1", [reply(404)]);
    expect(await getHotlistContentsTE("tok", "B")).toEqual({ status: 404, message: "Failed to collect Hotlist records" });
  });
});

// =============================================================================
// POST /get-hotlist-te
// =============================================================================
const call = (path, opts) => worker.fetch(makeRequest(path, opts), env, {});
const post = (json, opts = {}) => call("/get-hotlist-te", { method: "POST", json, ...opts });

describe("POST /get-hotlist-te", () => {
  it.each(["GET", "PUT", "DELETE"])("returns 405 for %s without touching Top Echelon", async (method) => {
    const res = await call("/get-hotlist-te", { method });

    expect(res.status).toBe(405);
    expect(http.calls).toHaveLength(0);
    expect(getAccessTokenTE).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["an array", []],
    ["a string", "hello"],
    ["null", null],
  ])("returns 400 when the body is %s", async (_label, body) => {
    const res = await post(body);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Body must be a JSON object");
    expect(http.calls).toHaveLength(0);
  });

  it.each([[{}], [{ hotlist: "" }], [{ hotlist: null }]])("returns 400 when the hotlist is missing: %j", async (body) => {
    const res = await post(body);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Hotlist not specified");
  });

  it.each([[{ hotlist: 5 }], [{ hotlist: ["a"] }], [{ hotlist: {} }], [{ hotlist: "   " }]])(
    "returns 400 when the hotlist is not a non-empty string: %j",
    async (body) => {
      const res = await post(body);

      expect(res.status).toBe(400);
      expect(await res.text()).toBe("Hotlist must be a non-empty string");
      expect(http.calls).toHaveLength(0);
    }
  );

  it("returns 400 for an unknown type", async () => {
    const res = await post({ hotlist: "X", type: "robot" });

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("type must be 'person', 'company' or 'job'");
    expect(http.calls).toHaveLength(0);
  });

  it("returns the hotlist's records as JSON", async () => {
    mockSearch("Shortlist", [{ id: "hl-1", name: "Shortlist" }]);
    mockRecords("hl-1", [ok({ entries: [entry("p1"), entry("p2")], pagination: { is_last_page: true } })]);

    const res = await post({ hotlist: "Shortlist" });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("X-Results-Truncated")).toBeNull();
    expect(await res.json()).toEqual([entry("p1"), entry("p2")]);
    expect(getAccessTokenTE).toHaveBeenCalledWith(env, "user-1");
  });

  it("returns 200 and [] for an empty hotlist", async () => {
    mockSearch("Empty", [{ id: "hl-1", name: "Empty" }]);
    mockRecords("hl-1", [ok({ entries: [] })]);

    const res = await post({ hotlist: "Empty" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("accepts hotlist names with special characters", async () => {
    mockSearch("R&D #1", [{ id: "hl-1", name: "R&D #1" }]);
    mockRecords("hl-1", [ok({ entries: [] })]);

    expect((await post({ hotlist: "R&D #1" })).status).toBe(200);
  });

  it("passes the type through for job hotlists", async () => {
    mockSearch("Job Board", [{ id: "hl-j", name: "Job Board" }], { type: "job" });
    mockRecords("hl-j", [ok({ entries: [{ id: "j1", type: "job" }] })]);

    const res = await post({ hotlist: "Job Board", type: "job" });

    expect(await res.json()).toEqual([{ id: "j1", type: "job" }]);
  });

  it("sets X-Results-Truncated when Top Echelon reports more pages", async () => {
    mockSearch("Big", [{ id: "hl-1", name: "Big" }]);
    mockRecords("hl-1", [ok({ entries: [entry("p1")], pagination: { is_last_page: false } })]);

    const res = await post({ hotlist: "Big" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Results-Truncated")).toBe("true");
  });

  it("returns 404 and creates nothing when the hotlist doesn't exist", async () => {
    mockSearch("Nope", []);

    const res = await post({ hotlist: "Nope" });

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Hotlist not found");
    expect(http.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("returns 500 when Top Echelon fails", async () => {
    mockSearch("X", [{ id: "hl-1", name: "X" }]);
    mockRecords("hl-1", [reply(500)]);

    const res = await post({ hotlist: "X" });

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Failed to collect Hotlist records");
  });

  it("does not check the Origin header (like the other record endpoints)", async () => {
    mockSearch("X", [{ id: "hl-1", name: "X" }]);
    mockRecords("hl-1", [ok({ entries: [] })]);

    expect((await post({ hotlist: "X" }, { origin: "https://evil.example" })).status).toBe(200);
  });
});