import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Integration tests: form.js + the REAL database-actions.js, with only the
// network (fetch) and the utilities mocked. Verifies the actual HTTP requests
// a submission produces and how API responses map to the final status.
vi.mock("../src/utilities.js", () => ({
  uid: vi.fn(),
  getDateString: vi.fn(),
  retryTimer: vi.fn(),
}));

import { uid, getDateString, retryTimer } from "../src/utilities.js";
import { fractionalSubmission, advisorySubmission } from "../src/form.js";
import { createFetchMock, ok, reply, buildFormData } from "./helpers.js";

const TE = "https://bb3api.topechelon.com/public/v1";
const TOKEN = "te-token";

let http;

beforeEach(() => {
  http = createFetchMock();
  http.install();
  uid.mockReset().mockReturnValue("sub-123");
  getDateString.mockReset().mockReturnValue("2026-10-06");
  retryTimer.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  http.assertAllConsumed();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (call) => JSON.parse(call.body);

/** Mock the whole happy-path conversation with Top Echelon */
function mockHappyPath(hotlistName, { personEmails = [] } = {}) {
  http.on("POST", `${TE}/people/parse`, [reply(201)]);
  http.on("POST", `${TE}/people/search`, [
    ok({ pagination: { total_count: 1 }, entries: [{ id: 99, email_addresses: personEmails }] }),
  ]);
  http.on("PUT", `${TE}/people/99`, [ok()]);
  http.on("POST", `${TE}/people/99/attachments`, [reply(201)]);
  http.on("GET", `${TE}/hotlists`, [ok({ metadata: { resultset: { count: 1 } }, results: [{ id: "hl-1" }] })], {
    record_type: "person",
    name: hotlistName,
    page: "1",
  });
  http.on("POST", `${TE}/hotlists/hl-1/add_record`, [ok()], { record_id: "99" });
}

describe("fractionalSubmission (integration)", () => {
  it("makes the expected sequence of Top Echelon requests", async () => {
    mockHappyPath("fractional");

    const result = await fractionalSubmission(TOKEN, buildFormData({ type: "fractional" }));

    expect(result).toEqual({ id: "sub-123", status: 200, message: "Person record created successfully" });
    expect(http.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "POST /public/v1/people/parse",
      "POST /public/v1/people/search",
      "PUT /public/v1/people/99",
      "POST /public/v1/people/99/attachments",
      "GET /public/v1/hotlists",
      "POST /public/v1/hotlists/hl-1/add_record",
    ]);
    // every request is authenticated
    expect(http.calls.every((c) => c.headers.get("authorization") === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("sends the resume, search filter, update body and response file", async () => {
    mockHappyPath("fractional");

    await fractionalSubmission(TOKEN, buildFormData({ type: "fractional" }));

    const [parse, search, update, attachment] = http.calls;
    expect(parse.body.get("file").name).toBe("resume.pdf");
    expect(json(search).person_search).toEqual({ keyword: "Jane Doe", minimum_date_modified: "2026-10-06" });
    expect(json(update).person).toMatchObject({
      first_name: "Jane",
      sourced_from: "Website - Fractional Form",
      work_history_update: { title: "VP Engineering", company_name: "Acme Corp", is_present_job: true },
      email_addresses_attributes: [{ email: "jane@example.com", primary: true }],
    });
    const file = attachment.body.get("file");
    expect(file.name).toBe("responses.txt");
    expect(await file.text()).toContain("Name: Jane Doe");
  });

  it("skips the email update when the record already has the email", async () => {
    mockHappyPath("fractional", { personEmails: [{ email: "jane@example.com" }] });

    await fractionalSubmission(TOKEN, buildFormData({ type: "fractional" }));

    const update = http.calls.find((c) => c.method === "PUT");
    expect(json(update).person).not.toHaveProperty("email_addresses_attributes");
  });

  it("creates the hotlist if it doesn't exist yet", async () => {
    http.on("POST", `${TE}/people/parse`, [reply(201)]);
    http.on("POST", `${TE}/people/search`, [
      ok({ pagination: { total_count: 1 }, entries: [{ id: 99, email_addresses: [] }] }),
    ]);
    http.on("PUT", `${TE}/people/99`, [ok()]);
    http.on("POST", `${TE}/people/99/attachments`, [reply(201)]);
    http.on("GET", `${TE}/hotlists`, [ok({ metadata: { resultset: { count: 0 } }, results: [] })]);
    http.on("POST", `${TE}/hotlists`, [reply(201, { hotlist: { id: "hl-new" } })]);
    http.on("POST", `${TE}/hotlists/hl-new/add_record`, [ok()], { record_id: "99" });

    const result = await fractionalSubmission(TOKEN, buildFormData({ type: "fractional" }));

    expect(result.status).toBe(200);
  });

  it("stops at the attachment step when it fails, never touching hotlists", async () => {
    http.on("POST", `${TE}/people/parse`, [reply(201)]);
    http.on("POST", `${TE}/people/search`, [
      ok({ pagination: { total_count: 1 }, entries: [{ id: 99, email_addresses: [] }] }),
    ]);
    http.on("PUT", `${TE}/people/99`, [ok()]);
    http.on("POST", `${TE}/people/99/attachments`, [reply(500)]);

    const result = await fractionalSubmission(TOKEN, buildFormData({ type: "fractional" }));

    expect(result).toEqual({ id: "sub-123", status: 500, message: "Attachment error" });
    expect(http.calls.some((c) => c.url.pathname.includes("hotlists"))).toBe(false);
  });

  it("surfaces a hotlist authentication failure", async () => {
    http.on("POST", `${TE}/people/parse`, [reply(201)]);
    http.on("POST", `${TE}/people/search`, [
      ok({ pagination: { total_count: 1 }, entries: [{ id: 99, email_addresses: [] }] }),
    ]);
    http.on("PUT", `${TE}/people/99`, [ok()]);
    http.on("POST", `${TE}/people/99/attachments`, [reply(201)]);
    http.on("GET", `${TE}/hotlists`, [ok({ metadata: { resultset: { count: 1 } }, results: [{ id: "hl-1" }] })]);
    http.on("POST", `${TE}/hotlists/hl-1/add_record`, [reply(401)]);

    const result = await fractionalSubmission(TOKEN, buildFormData({ type: "fractional" }));

    expect(result).toEqual({ id: "sub-123", status: 401, message: "Authentication error" });
  });

  it("makes no requests at all for an invalid form", async () => {
    const result = await fractionalSubmission(TOKEN, buildFormData({ type: "fractional", omit: ["email"] }));

    expect(result.status).toBe(400);
    expect(http.calls).toHaveLength(0);
  });
});

describe("advisorySubmission (integration)", () => {
  it("completes the full flow and uses the Advisory Leads hotlist", async () => {
    mockHappyPath("Advisory Leads");

    const result = await advisorySubmission(TOKEN, buildFormData({ type: "advisory" }));

    expect(result).toEqual({ id: "sub-123", status: 200, message: "Person record created successfully" });
    const update = http.calls.find((c) => c.method === "PUT");
    expect(json(update).person.sourced_from).toBe("Website - Advisory Form");
    expect(json(update).person).not.toHaveProperty("work_history_update");
  });

  it("passes through a parse failure", async () => {
    http.on("POST", `${TE}/people/parse`, [reply(422)]);

    const result = await advisorySubmission(TOKEN, buildFormData({ type: "advisory" }));

    expect(result).toEqual({ id: "sub-123", status: 422, message: "Parse error" });
    expect(http.calls).toHaveLength(1);
  });
});