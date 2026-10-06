import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Integration tests for the Top Echelon / website-facing endpoints.
// Real: worker.js, form.js, database-actions.js, and the HTTP requests they make (mocked fetch).
// Mocked: authenticate.js and admin.js (their internals are outside this suite) and utilities.js.
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
import {
  getAccessTokenTE,
  newAccessTokenTE,
  updateAccessTokenN,
} from "../src/authenticate.js";
import { findDuplicatesTE } from "../src/admin.js";
import { uid, getDateString, retryTimer } from "../src/utilities.js";
import {
  createFetchMock, ok, reply, buildFormData,
  makeWorkerEnv, makeRequest, expectCors, SITE_ORIGIN,
} from "./helpers.js";

const TE = "https://bb3api.topechelon.com/public/v1";

let http;
let env;

/** Send a request through the Worker's fetch handler */
const call = (path, opts) => worker.fetch(makeRequest(path, opts), env, {});

beforeEach(() => {
  http = createFetchMock();
  http.install();
  env = makeWorkerEnv({ userId: "user-1" });

  getAccessTokenTE.mockReset().mockResolvedValue("te-token");
  newAccessTokenTE.mockReset().mockResolvedValue(200);
  updateAccessTokenN.mockReset().mockResolvedValue(undefined);
  findDuplicatesTE.mockReset();
  uid.mockReset().mockReturnValue("sub-123");
  getDateString.mockReset().mockReturnValue("2026-10-06");
  retryTimer.mockReset().mockResolvedValue(undefined);

  for (const m of ["log", "warn", "error"]) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
  http.assertAllConsumed();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// =============================================================================
// CORS preflight + unknown routes
// =============================================================================
describe("OPTIONS (CORS preflight)", () => {
  it.each(["/fractional", "/advisory", "/admin/delete", "/anything-else"])(
    "answers the preflight for %s without touching any service",
    async (path) => {
      const res = await call(path, { method: "OPTIONS", origin: SITE_ORIGIN });

      expect(res.status).toBe(200);
      expectCors(res);
      expect(await res.text()).toBe("");
      expect(getAccessTokenTE).not.toHaveBeenCalled();
      expect(http.calls).toHaveLength(0);
    }
  );
});

describe("unknown routes", () => {
  it("returns 404 for an unknown path", async () => {
    const res = await call("/nope");

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Page not found");
  });
});

// =============================================================================
// /topechelon/callback
// =============================================================================
describe("/topechelon/callback", () => {
  it("passes the code and user id to newAccessTokenTE", async () => {
    await call("/topechelon/callback?code=abc123");

    expect(newAccessTokenTE).toHaveBeenCalledWith(env, "abc123", "user-1");
  });

  it("responds 200 when the token was created", async () => {
    const res = await call("/topechelon/callback?code=abc123");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Response: 200");
  });

  it.each([401, 500])("mirrors a failing status from newAccessTokenTE (%i)", async (status) => {
    newAccessTokenTE.mockResolvedValue(status);

    const res = await call("/topechelon/callback?code=abc123");

    expect(res.status).toBe(status);
    expect(await res.text()).toBe(`Response: ${status}`);
  });

  it("passes a null code through when none is supplied", async () => {
    await call("/topechelon/callback");

    expect(newAccessTokenTE).toHaveBeenCalledWith(env, null, "user-1");
  });
});

// =============================================================================
// /refresh-token-te
// =============================================================================
describe("/refresh-token-te", () => {
  it("refreshes the token and returns 200", async () => {
    const res = await call("/refresh-token-te");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Token refreshed, check KV");
    expect(getAccessTokenTE).toHaveBeenCalledWith(env, "user-1");
  });

  it("returns a 500 with CORS headers if the refresh blows up", async () => {
    getAccessTokenTE.mockRejectedValue(new Error("KV down"));

    const res = await call("/refresh-token-te");

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Server Error");
    expectCors(res);
  });
});

// =============================================================================
// /update-token-n
// =============================================================================
describe("/update-token-n", () => {
  const post = (opts = {}) =>
    call("/update-token-n", { method: "POST", origin: SITE_ORIGIN, body: "ntn_secret123", ...opts });

  it("stores a valid Notion token and returns 200", async () => {
    const res = await post();

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PAT updates successfully.");
    expect(updateAccessTokenN).toHaveBeenCalledWith(env, "user-1", "ntn_secret123");
  });

  it("returns 405 for non-POST methods", async () => {
    const res = await call("/update-token-n", { method: "GET", origin: SITE_ORIGIN });

    expect(res.status).toBe(405);
    expect(await res.text()).toBe("Method not allowed");
  });

  it("returns 403 for a foreign origin", async () => {
    const res = await post({ origin: "https://evil.example.com" });

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
    expect(updateAccessTokenN).not.toHaveBeenCalled();
  });

  it("returns 403 when there is no Origin header", async () => {
    const res = await post({ origin: undefined });

    expect(res.status).toBe(403);
  });

  it("checks the method before the origin", async () => {
    const res = await call("/update-token-n", { method: "GET", origin: "https://evil.example.com" });

    expect(res.status).toBe(405);
  });

  it.each(["secret_abc", "", "NTN_upper", " ntn_leading-space"])(
    "returns 400 for an invalid token (%j)",
    async (token) => {
      const res = await post({ body: token });

      expect(res.status).toBe(400);
      expect(await res.text()).toBe("Invalid token detected");
      expect(updateAccessTokenN).not.toHaveBeenCalled();
    }
  );
});

// =============================================================================
// /fractional and /advisory (full flow through form.js + database-actions.js)
// =============================================================================
const forms = [
  { path: "/fractional", type: "fractional", hotlist: "fractional", source: "Website - Fractional Form" },
  { path: "/advisory", type: "advisory", hotlist: "Advisory Leads", source: "Website - Advisory Form" },
];

/**
 * Mock the Top Echelon conversation for one submission attempt.
 * `parse` lets a test supply a custom sequence of responses for the parse call.
 */
function mockSubmission(hotlistName, { parse = [reply(201)], rest = true } = {}) {
  http.on("POST", `${TE}/people/parse`, parse);
  if (!rest) return;
  http.on("POST", `${TE}/people/search`, [
    ok({ pagination: { total_count: 1 }, entries: [{ id: 99, email_addresses: [] }] }),
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

describe.each(forms)("$path", ({ path, type, hotlist, source }) => {
  const submit = (opts = {}) =>
    call(path, {
      method: "POST",
      origin: SITE_ORIGIN,
      body: buildFormData({ type }),
      ...opts,
    });

  // ---- Request gating -------------------------------------------------------
  describe("request checks", () => {
    it("returns 405 for non-POST methods", async () => {
      const res = await call(path, { method: "GET", origin: SITE_ORIGIN });

      expect(res.status).toBe(405);
      expect(await res.text()).toBe("Method not allowed");
    });

    it("returns 403 for a foreign origin", async () => {
      const res = await submit({ origin: "https://evil.example.com" });

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("Forbidden");
      expect(http.calls).toHaveLength(0);
    });

    it("returns 403 when there is no Origin header", async () => {
      const res = await submit({ origin: undefined });

      expect(res.status).toBe(403);
    });

    it("checks the method before the origin", async () => {
      const res = await call(path, { method: "PUT", origin: "https://evil.example.com" });

      expect(res.status).toBe(405);
    });
  });

  // ---- Success --------------------------------------------------------------
  describe("successful submission", () => {
    it("returns 200 with CORS headers", async () => {
      mockSubmission(hotlist);

      const res = await submit();

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("Form submitted successfully.");
      expectCors(res);
    });

    it("runs the full Top Echelon flow with the stored token", async () => {
      mockSubmission(hotlist);

      await submit();

      expect(getAccessTokenTE).toHaveBeenCalledWith(env, "user-1");
      expect(http.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
        "POST /public/v1/people/parse",
        "POST /public/v1/people/search",
        "PUT /public/v1/people/99",
        "POST /public/v1/people/99/attachments",
        "GET /public/v1/hotlists",
        "POST /public/v1/hotlists/hl-1/add_record",
      ]);
      expect(http.calls.every((c) => c.headers.get("authorization") === "Bearer te-token")).toBe(true);
    });

    it("forwards the uploaded resume and form answers", async () => {
      mockSubmission(hotlist);

      await submit();

      const [parse, , update, attachment] = http.calls;
      expect(parse.body.get("file").name).toBe("resume.pdf");
      expect(JSON.parse(update.body).person).toMatchObject({
        first_name: "Jane",
        last_name: "Doe",
        sourced_from: source,
      });
      expect(await attachment.body.get("file").text()).toContain("Name: Jane Doe");
    });
  });

  // ---- Bad input ------------------------------------------------------------
  describe("invalid submissions", () => {
    it("returns 400 with the validation message and CORS headers", async () => {
      const res = await submit({ body: buildFormData({ type, omit: ["email"] }) });

      expect(res.status).toBe(400);
      expect(await res.text()).toBe("Missing fields: email, ");
      expectCors(res);
      expect(http.calls).toHaveLength(0);
    });

    it("returns 400 for a malformed LinkedIn link", async () => {
      const res = await submit({
        body: buildFormData({ type, overrides: { linkedIn: "https://example.com/in/jane" } }),
      });

      expect(res.status).toBe(400);
      expect(await res.text()).toBe("Link to LinkedIn profile is malformed");
    });
  });

  // ---- Top Echelon failures -------------------------------------------------
  describe("Top Echelon errors", () => {
    it.each([403, 500])("aborts with a 500 when Top Echelon returns %i", async (status) => {
      mockSubmission(hotlist, { parse: [reply(status)], rest: false });

      const res = await submit();

      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Parse error");
      expectCors(res);
      expect(http.callsTo("POST", "/public/v1/people/parse")).toHaveLength(1); // no retry
    });

    it.each([401, 404, 422, 429])(
      "retries the whole submission after a %i and succeeds",
      async (status) => {
        mockSubmission(hotlist, { parse: [reply(status), reply(201)] });

        const res = await submit();

        expect(res.status).toBe(200);
        expect(http.callsTo("POST", "/public/v1/people/parse")).toHaveLength(2);
        expect(getAccessTokenTE).toHaveBeenCalledTimes(2); // fresh token per attempt
      }
    );

    it("gives up with a 500 after repeated retryable errors", async () => {
      // Four failed attempts are mocked; a fifth would hit an unmocked request.
      mockSubmission(hotlist, {
        parse: [reply(422), reply(422), reply(422), reply(422)],
        rest: false,
      });

      const res = await submit();

      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Repeated error(s) when submitting");
      expectCors(res);
      expect(http.callsTo("POST", "/public/v1/people/parse")).toHaveLength(4);
    });

    it("returns a 500 with CORS headers when something throws", async () => {
      getAccessTokenTE.mockRejectedValue(new Error("KV down"));

      const res = await submit();

      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Server Error");
      expectCors(res);
    });
  });
});

// =============================================================================
// /admin/duplicates
// =============================================================================
describe("/admin/duplicates", () => {
  const get = (opts = {}) => call("/admin/duplicates", { method: "GET", origin: SITE_ORIGIN, ...opts });

  it("returns the duplicates map as a JSON object", async () => {
    findDuplicatesTE.mockResolvedValue({
      status: 200,
      duplicates: new Map([
        ["Jane Doe", [1, 2]],
        ["John Roe", [3, 4, 5]],
      ]),
    });

    const res = await get();

    expect(res.status).toBe(200);
    expectCors(res);
    expect(await res.json()).toEqual({ "Jane Doe": [1, 2], "John Roe": [3, 4, 5] });
    expect(findDuplicatesTE).toHaveBeenCalledWith("te-token");
  });

  it("returns an empty object when there are no duplicates", async () => {
    findDuplicatesTE.mockResolvedValue({ status: 200, duplicates: new Map() });

    const res = await get();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("hides the failure details behind a 500 with CORS headers", async () => {
    findDuplicatesTE.mockResolvedValue({ status: 403, message: "secret detail" });

    const res = await get();

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Server Error");
    expectCors(res);
  });

  it("returns 405 for non-GET methods", async () => {
    const res = await get({ method: "POST" });

    expect(res.status).toBe(405);
    expect(findDuplicatesTE).not.toHaveBeenCalled();
  });

  it("returns 403 for a foreign origin", async () => {
    const res = await get({ origin: "https://evil.example.com" });

    expect(res.status).toBe(403);
    expect(findDuplicatesTE).not.toHaveBeenCalled();
  });

  it("returns 403 when there is no Origin header", async () => {
    const res = await get({ origin: undefined });

    expect(res.status).toBe(403);
  });
});

// =============================================================================
// /admin/delete
// =============================================================================
describe("/admin/delete", () => {
  const post = (opts = {}) =>
    call("/admin/delete", { method: "POST", origin: SITE_ORIGIN, json: [101, 102], ...opts });

  function mockDeleteHotlist(addResponses = {}) {
    http.on("GET", `${TE}/hotlists`, [ok({ metadata: { resultset: { count: 1 } }, results: [{ id: "hl-del" }] })], {
      record_type: "person",
      name: "delete",
      page: "1",
    });
    http.on("POST", `${TE}/hotlists/hl-del/add_record`, [addResponses[101] ?? ok()], { record_id: "101" });
    http.on("POST", `${TE}/hotlists/hl-del/add_record`, [addResponses[102] ?? ok()], { record_id: "102" });
  }

  it("adds every record to the 'delete' hotlist", async () => {
    mockDeleteHotlist();

    const res = await post();

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Records added to hotlist.");
    expectCors(res);
    expect(http.callsTo("POST", "/public/v1/hotlists/hl-del/add_record")).toHaveLength(2);
    expect(http.calls.every((c) => c.headers.get("authorization") === "Bearer te-token")).toBe(true);
  });

  it("succeeds without adding anything for an empty list", async () => {
    http.on("GET", `${TE}/hotlists`, [ok({ metadata: { resultset: { count: 1 } }, results: [{ id: "hl-del" }] })]);

    const res = await post({ json: [] });

    expect(res.status).toBe(200);
    expect(http.callsTo("POST", "/public/v1/hotlists/hl-del/add_record")).toHaveLength(0);
  });

  it("returns a generic 500 with CORS headers when the hotlist can't be found", async () => {
    http.on("GET", `${TE}/hotlists`, [reply(500)]);

    const res = await post();

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Server Error please try again later...");
    expectCors(res);
  });

  it("returns a generic 500 when Top Echelon rejects the token (401)", async () => {
    // A 401 aborts at the first record, so only that record is mocked
    http.on("GET", `${TE}/hotlists`, [ok({ metadata: { resultset: { count: 1 } }, results: [{ id: "hl-del" }] })]);
    http.on("POST", `${TE}/hotlists/hl-del/add_record`, [reply(401)], { record_id: "101" });

    const res = await post();

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Server Error please try again later...");
  });

  it("returns a 500 with CORS headers for a malformed JSON body", async () => {
    const res = await post({ json: "{not json" });

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Server Error");
    expectCors(res);
  });

  it("returns 405 for non-POST methods", async () => {
    const res = await post({ method: "GET", json: undefined });

    expect(res.status).toBe(405);
    expect(http.calls).toHaveLength(0);
  });

  it("returns 403 for a foreign origin", async () => {
    const res = await post({ origin: "https://evil.example.com" });

    expect(res.status).toBe(403);
    expect(http.calls).toHaveLength(0);
  });

  it("returns 403 when there is no Origin header", async () => {
    const res = await post({ origin: undefined });

    expect(res.status).toBe(403);
  });
});