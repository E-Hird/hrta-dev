import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// retryTimer would really wait; replace it so tests are instant and inspectable
vi.mock("../src/utilities.js", () => ({ retryTimer: vi.fn() }));
import { retryTimer } from "../src/utilities.js";

import {
  addToHotlistTE,
  getHotlistRecordsTE,
  parseFromResumeTE,
  findRecordTE,
  updateRecordTE,
  addAttachmentTE,
} from "../src/database-actions.js";
import { createFetchMock, ok, reply } from "./helpers.js";

const TE = "https://bb3api.topechelon.com/public/v1";
const TOKEN = "te-token";

let http;
let errorSpy;

beforeEach(() => {
  http = createFetchMock();
  http.install();
  retryTimer.mockReset();
  retryTimer.mockResolvedValue(undefined); // a (truthy) promise that resolves instantly
  vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  http.assertAllConsumed(); // every mocked response must have been used
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (call) => JSON.parse(call.body);

// ---- Shared mock builders ---------------------------------------------------

/** Mock "hotlist already exists" for the name search */
function mockHotlistExists(id = "hl-1", name = "Leads", type = "person") {
  http.on("GET", `${TE}/hotlists`, [ok({ metadata: { resultset: { count: 1 } }, results: [{ id }] })], {
    record_type: type,
    name,
    page: "1",
  });
}

/** Mock the add_record call for a given hotlist + record */
function mockAddRecord(hotlistId, recordId, responses) {
  http.on("POST", `${TE}/hotlists/${hotlistId}/add_record`, responses, { record_id: recordId });
}

// =============================================================================
// addToHotlistTE  (also covers the un-exported getHotlistIdTE)
// =============================================================================
describe("addToHotlistTE", () => {
  it("adds every record to an existing hotlist", async () => {
    mockHotlistExists("hl-1");
    mockAddRecord("hl-1", "r1", [ok()]);
    mockAddRecord("hl-1", "r2", [ok()]);

    const result = await addToHotlistTE(TOKEN, "Leads", ["r1", "r2"]);

    expect(result).toEqual({ status: 200, message: "Added to hotlist successfully" });
    const adds = http.callsTo("POST", "/public/v1/hotlists/hl-1/add_record");
    expect(adds).toHaveLength(2);
    expect(adds[0].headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("creates the hotlist when the search finds none, then uses the new id", async () => {
    http.on("GET", `${TE}/hotlists`, [ok({ metadata: { resultset: { count: 0 } }, results: [] })]);
    http.on("POST", `${TE}/hotlists`, [reply(201, { hotlist: { id: "new-1" } })], {
      record_type: "person",
    });
    mockAddRecord("new-1", "r1", [ok()]);

    const result = await addToHotlistTE(TOKEN, "Leads", ["r1"]);

    expect(result.status).toBe(200);
    const [create] = http.callsTo("POST", "/public/v1/hotlists");
    expect(json(create)).toEqual({ hotlist: { name: "Leads", share_with_agency: true } });
    expect(create.headers.get("content-type")).toBe("application/json");
  });

  it("passes the record type through to the hotlist search", async () => {
    mockHotlistExists("hl-co", "Leads", "company"); // query must contain record_type=company
    mockAddRecord("hl-co", "c1", [ok()]);

    const result = await addToHotlistTE(TOKEN, "Leads", ["c1"], "company");

    expect(result.status).toBe(200);
  });

  it("returns 500 when the hotlist search fails", async () => {
    http.on("GET", `${TE}/hotlists`, [reply(500)]);

    const result = await addToHotlistTE(TOKEN, "Leads", ["r1"]);

    expect(result).toEqual({ status: 500, message: "Hotlist could not be found or created" });
    expect(errorSpy).toHaveBeenCalled();
  });

  it("returns 500 when the hotlist cannot be created", async () => {
    http.on("GET", `${TE}/hotlists`, [ok({ metadata: { resultset: { count: 0 } }, results: [] })]);
    http.on("POST", `${TE}/hotlists`, [reply(400)]);

    const result = await addToHotlistTE(TOKEN, "Leads", ["r1"]);

    expect(result).toEqual({ status: 500, message: "Hotlist could not be found or created" });
  });

  it("succeeds without adding anything when given no records", async () => {
    mockHotlistExists("hl-1");

    const result = await addToHotlistTE(TOKEN, "Leads", []);

    expect(result.status).toBe(200);
    expect(http.callsTo("POST", "/public/v1/hotlists/hl-1/add_record")).toHaveLength(0);
  });

  it("stops immediately on a 401", async () => {
    mockHotlistExists("hl-1");
    mockAddRecord("hl-1", "r1", [reply(401)]);
    // r2 is deliberately not mocked: reaching it would throw

    const result = await addToHotlistTE(TOKEN, "Leads", ["r1", "r2"]);

    expect(result).toEqual({ status: 401, message: "Authentication error" });
    expect(http.callsTo("POST", "/public/v1/hotlists/hl-1/add_record")).toHaveLength(1);
  });

  it("waits for the Retry-After header on a 429, then retries", async () => {
    mockHotlistExists("hl-1");
    mockAddRecord("hl-1", "r1", [reply(429, {}, { "Retry-After": "2" }), ok()]);

    const result = await addToHotlistTE(TOKEN, "Leads", ["r1"]);

    expect(result.status).toBe(200);
    expect(retryTimer).toHaveBeenCalledWith("2");
    expect(http.callsTo("POST", "/public/v1/hotlists/hl-1/add_record")).toHaveLength(2);
  });

  it("returns 429 when the retry timer is unusable", async () => {
    mockHotlistExists("hl-1");
    mockAddRecord("hl-1", "r1", [reply(429, {}, { "Retry-After": "99999" })]);
    retryTimer.mockReturnValueOnce(null); // e.g. wait too long

    const result = await addToHotlistTE(TOKEN, "Leads", ["r1"]);

    expect(result).toEqual({ status: 429, message: "Retry timer broken or too long" });
  });

  it("retries other failures after a 5 second wait", async () => {
    mockHotlistExists("hl-1");
    mockAddRecord("hl-1", "r1", [reply(500), ok()]);

    const result = await addToHotlistTE(TOKEN, "Leads", ["r1"]);

    expect(result.status).toBe(200);
    expect(retryTimer).toHaveBeenCalledWith(5);
  });

  it("gives up on a record after repeated failures and moves on to the next", async () => {
    mockHotlistExists("hl-1");
    mockAddRecord("hl-1", "r1", [reply(500), reply(500), reply(500), reply(500)]);
    mockAddRecord("hl-1", "r2", [ok()]);

    const result = await addToHotlistTE(TOKEN, "Leads", ["r1", "r2"]);

    // NOTE: current behaviour reports overall success even though r1 was skipped
    expect(result.status).toBe(200);
    expect(retryTimer).toHaveBeenCalledTimes(4);
    expect(errorSpy).toHaveBeenCalledWith("Too many retries");
    expect(http.callsTo("POST", "/public/v1/hotlists/hl-1/add_record")).toHaveLength(5);
  });
});

// =============================================================================
// getHotlistRecordsTE
// =============================================================================
describe("getHotlistRecordsTE", () => {
  it("returns the records of a hotlist", async () => {
    mockHotlistExists("hl-1");
    http.on("GET", `${TE}/hl-1/all_records`, [ok({ entries: [{ id: 1 }, { id: 2 }] })]);

    const result = await getHotlistRecordsTE(TOKEN, "Leads");

    expect(result).toEqual({
      status: 200,
      message: "Found Hotlist records",
      results: [{ id: 1 }, { id: 2 }],
    });
  });

  it("returns 404 when the hotlist has no records", async () => {
    mockHotlistExists("hl-1");
    http.on("GET", `${TE}/hl-1/all_records`, [ok({ entries: [] })]);

    const result = await getHotlistRecordsTE(TOKEN, "Leads");

    expect(result).toEqual({ status: 404, message: "Hotlist contains no records" });
  });

  it("passes through the status when records can't be fetched", async () => {
    mockHotlistExists("hl-1");
    http.on("GET", `${TE}/hl-1/all_records`, [reply(403)]);

    const result = await getHotlistRecordsTE(TOKEN, "Leads");

    expect(result).toEqual({ status: 403, message: "Failed to collect Hotlist records" });
  });

  it("returns 500 when the hotlist can't be found or created", async () => {
    http.on("GET", `${TE}/hotlists`, [reply(500)]);

    const result = await getHotlistRecordsTE(TOKEN, "Leads");

    expect(result).toEqual({ status: 500, message: "Hotlist could not be found or created" });
  });

  it("sends the bearer token", async () => {
    mockHotlistExists("hl-1");
    http.on("GET", `${TE}/hl-1/all_records`, [ok({ entries: [{ id: 1 }] })]);

    await getHotlistRecordsTE(TOKEN, "Leads");

    const [call] = http.callsTo("GET", "/public/v1/hl-1/all_records");
    expect(call.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });
});

// =============================================================================
// parseFromResumeTE
// =============================================================================
describe("parseFromResumeTE", () => {
  const resume = () => new File(["resume text"], "resume.pdf", { type: "application/pdf" });

  it("uploads the resume as multipart form data with the auth header", async () => {
    http.on("POST", `${TE}/people/parse`, [ok()]);

    await parseFromResumeTE(TOKEN, resume());

    const [call] = http.callsTo("POST", "/public/v1/people/parse");
    expect(call.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(call.body).toBeInstanceOf(FormData);
    expect(call.body.get("file").name).toBe("resume.pdf");
  });

  it.each([200, 201, 422, 500])("returns the response status (%i)", async (status) => {
    http.on("POST", `${TE}/people/parse`, [reply(status)]);

    expect(await parseFromResumeTE(TOKEN, resume())).toBe(status);
  });
});

// =============================================================================
// findRecordTE
// =============================================================================
describe("findRecordTE", () => {
  const found = ok({ pagination: { total_count: 1 }, entries: [{ id: 42, name: "Jane" }] });
  const empty = ok({ pagination: { total_count: 0 }, entries: [] });
  const filters = { email: "jane@example.com" };

  it("returns the first matching record", async () => {
    http.on("POST", `${TE}/people/search`, [found]);

    const result = await findRecordTE(TOKEN, filters);

    expect(result).toEqual({
      status: 200,
      message: "Person record found",
      result: { id: 42, name: "Jane" },
    });
  });

  it("sends the filters with default sorting", async () => {
    http.on("POST", `${TE}/people/search`, [found]);

    await findRecordTE(TOKEN, filters);

    const [call] = http.callsTo("POST", "/public/v1/people/search");
    expect(json(call)).toEqual({
      page: 1,
      sort_by: "date_added",
      sort_order: "desc",
      person_search: filters,
    });
  });

  it("respects custom sorting", async () => {
    http.on("POST", `${TE}/people/search`, [found]);

    await findRecordTE(TOKEN, filters, "last_name", "asc");

    const [call] = http.callsTo("POST", "/public/v1/people/search");
    expect(json(call)).toMatchObject({ sort_by: "last_name", sort_order: "asc" });
  });

  it("waits 1 second before each search attempt", async () => {
    http.on("POST", `${TE}/people/search`, [found]);

    await findRecordTE(TOKEN, filters);

    expect(retryTimer).toHaveBeenCalledWith(1);
  });

  it("keeps retrying until the record appears", async () => {
    http.on("POST", `${TE}/people/search`, [empty, empty, found]);

    const result = await findRecordTE(TOKEN, filters);

    expect(result.status).toBe(200);
    expect(http.callsTo("POST", "/public/v1/people/search")).toHaveLength(3);
    expect(retryTimer).toHaveBeenCalledTimes(3);
  });

  it("returns 404 after exhausting its retries", async () => {
    http.on("POST", `${TE}/people/search`, [empty, empty, empty, empty]);

    const result = await findRecordTE(TOKEN, filters);

    expect(result).toEqual({ status: 404, message: "Person record not found", result: null });
    expect(http.callsTo("POST", "/public/v1/people/search")).toHaveLength(4);
  });

  it("passes through a search error status", async () => {
    http.on("POST", `${TE}/people/search`, [reply(403)]);

    const result = await findRecordTE(TOKEN, filters);

    expect(result).toEqual({ status: 403, message: "Search error", result: null });
  });

  it("returns 500 without searching when the timer is unusable", async () => {
    retryTimer.mockReturnValueOnce(null);

    const result = await findRecordTE(TOKEN, filters);

    expect(result).toEqual({ status: 500, message: "Retry timer broken or too long", result: null });
    expect(http.calls).toHaveLength(0);
  });
});

// =============================================================================
// updateRecordTE
// =============================================================================
describe("updateRecordTE", () => {
  it("PUTs the update wrapped in a `person` object", async () => {
    http.on("PUT", `${TE}/people/123`, [ok()]);

    await updateRecordTE(TOKEN, "123", { first_name: "Jane" });

    const [call] = http.callsTo("PUT", "/public/v1/people/123");
    expect(json(call)).toEqual({ person: { first_name: "Jane" } });
    expect(call.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(call.headers.get("content-type")).toBe("application/json");
  });

  it.each([200, 404, 422])("returns the response status (%i)", async (status) => {
    http.on("PUT", `${TE}/people/123`, [reply(status)]);

    expect(await updateRecordTE(TOKEN, "123", {})).toBe(status);
  });
});

// =============================================================================
// addAttachmentTE
// =============================================================================
describe("addAttachmentTE", () => {
  const file = () => new File(["data"], "original-name.pdf", { type: "application/pdf" });

  it("uploads the file under the given attachment name", async () => {
    http.on("POST", `${TE}/people/123/attachments`, [ok()]);

    await addAttachmentTE(TOKEN, "123", file(), "Cover Letter.pdf");

    const [call] = http.callsTo("POST", "/public/v1/people/123/attachments");
    expect(call.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(call.body).toBeInstanceOf(FormData);
    expect(call.body.get("file").name).toBe("Cover Letter.pdf");
  });

  it.each([200, 201, 413, 500])("returns the response status (%i)", async (status) => {
    http.on("POST", `${TE}/people/123/attachments`, [reply(status)]);

    expect(await addAttachmentTE(TOKEN, "123", file(), "a.pdf")).toBe(status);
  });
});