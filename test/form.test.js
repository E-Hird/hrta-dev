import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Unit tests: the Top Echelon functions and utilities are mocked so these tests
// only exercise form.js's own logic (validation, ordering, payload building,
// error mapping). See form.integration.test.js for the real-fetch version.
vi.mock("../src/database-actions.js", () => ({
  addToHotlistTE: vi.fn(),
  parseFromResumeTE: vi.fn(),
  findRecordTE: vi.fn(),
  updateRecordTE: vi.fn(),
  addAttachmentTE: vi.fn(),
}));
vi.mock("../src/utilities.js", () => ({ uid: vi.fn(), getDateString: vi.fn() }));

import {
  addToHotlistTE,
  parseFromResumeTE,
  findRecordTE,
  updateRecordTE,
  addAttachmentTE,
} from "../src/database-actions.js";
import { uid, getDateString } from "../src/utilities.js";
import { fractionalSubmission, advisorySubmission } from "../src/form.js";
import {
  buildFormData,
  makePersonRecord,
  BASE_FORM_FIELDS,
  FRACTIONAL_FORM_FIELDS,
} from "./helpers.js";

const TOKEN = "te-token";
const NOW = new Date("2026-10-06T12:00:00Z").getTime();

beforeEach(() => {
  for (const fn of [
    addToHotlistTE, parseFromResumeTE, findRecordTE, updateRecordTE,
    addAttachmentTE, uid, getDateString,
  ]) {
    fn.mockReset();
  }
  // Default: everything succeeds
  uid.mockReturnValue("sub-123");
  getDateString.mockReturnValue("2026-10-06");
  parseFromResumeTE.mockResolvedValue(201);
  findRecordTE.mockResolvedValue({ status: 200, message: "Person record found", result: makePersonRecord() });
  updateRecordTE.mockResolvedValue(200);
  addAttachmentTE.mockResolvedValue(201);
  addToHotlistTE.mockResolvedValue({ status: 200, message: "Added to hotlist successfully" });

  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const variants = [
  {
    name: "fractionalSubmission",
    submit: fractionalSubmission,
    type: "fractional",
    hotlist: "fractional",
    source: "Website - Fractional Form",
  },
  {
    name: "advisorySubmission",
    submit: advisorySubmission,
    type: "advisory",
    hotlist: "Advisory Leads",
    source: "Website - Advisory Form",
  },
];

/** Nothing downstream should have been called */
function expectNoTopEchelonCalls() {
  for (const fn of [parseFromResumeTE, findRecordTE, updateRecordTE, addAttachmentTE, addToHotlistTE]) {
    expect(fn).not.toHaveBeenCalled();
  }
}

// =============================================================================
// Behaviour shared by both submission handlers
// =============================================================================
describe.each(variants)("$name (shared behaviour)", ({ submit, type, hotlist, source }) => {
  const form = (opts = {}) => buildFormData({ type, ...opts });

  // ---- Happy path -----------------------------------------------------------
  describe("successful submission", () => {
    it("returns 200 with the submission id", async () => {
      const result = await submit(TOKEN, form());

      expect(result).toEqual({
        id: "sub-123",
        status: 200,
        message: "Person record created successfully",
      });
    });

    it("runs the steps in order: parse, find, update, attach, hotlist", async () => {
      await submit(TOKEN, form());

      const order = [parseFromResumeTE, findRecordTE, updateRecordTE, addAttachmentTE, addToHotlistTE]
        .map((fn) => fn.mock.invocationCallOrder[0]);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(order.every(Boolean)).toBe(true);
    });

    it("sends the uploaded resume to be parsed", async () => {
      await submit(TOKEN, form());

      const [token, file] = parseFromResumeTE.mock.calls[0];
      expect(token).toBe(TOKEN);
      expect(file).toBeInstanceOf(File);
      expect(file.name).toBe("resume.pdf");
    });

    it("searches for the new record by full name and today's date", async () => {
      await submit(TOKEN, form());

      expect(getDateString).toHaveBeenCalledWith(new Date(NOW));
      expect(findRecordTE).toHaveBeenCalledWith(TOKEN, {
        keyword: "Jane Doe",
        minimum_date_modified: "2026-10-06",
      });
    });

    it("updates the located record with the submitted details", async () => {
      await submit(TOKEN, form());

      const [token, personId, body] = updateRecordTE.mock.calls[0];
      expect(token).toBe(TOKEN);
      expect(personId).toBe(99);
      expect(body).toMatchObject({
        first_name: "Jane",
        last_name: "Doe",
        linked_in: "https://www.linkedin.com/in/janedoe",
        city: "Austin",
        state: "TX",
        country: "USA",
        sourced_from: source,
      });
    });

    it("attaches the responses as responses.txt", async () => {
      await submit(TOKEN, form());

      const [token, personId, file, name] = addAttachmentTE.mock.calls[0];
      expect(token).toBe(TOKEN);
      expect(personId).toBe(99);
      expect(file).toBeInstanceOf(Blob);
      expect(file.type).toBe("text/plain");
      expect(name).toBe("responses.txt");
    });

    it("includes the applicant's details in the responses file", async () => {
      await submit(TOKEN, form());

      const text = await addAttachmentTE.mock.calls[0][2].text();
      expect(text).toContain("Name: Jane Doe");
      expect(text).toContain("Email: jane@example.com");
      expect(text).toContain("LinkedIn: https://www.linkedin.com/in/janedoe");
      expect(text).toContain("Location: Austin, TX, USA");
    });

    it(`adds the person to the "${hotlist}" hotlist`, async () => {
      await submit(TOKEN, form());

      expect(addToHotlistTE).toHaveBeenCalledWith(TOKEN, hotlist, [99]);
    });
  });

  // ---- Email handling -------------------------------------------------------
  describe("email handling", () => {
    it("adds the submitted email when the record doesn't have it", async () => {
      await submit(TOKEN, form());

      const body = updateRecordTE.mock.calls[0][2];
      expect(body.email_addresses_attributes).toEqual([
        { primary: true, type: "work", email: "jane@example.com", do_not_email: false },
      ]);
    });

    it("adds the email when the record has no emails at all", async () => {
      findRecordTE.mockResolvedValue({ status: 200, result: makePersonRecord({ email_addresses: [] }) });

      await submit(TOKEN, form());

      expect(updateRecordTE.mock.calls[0][2].email_addresses_attributes).toHaveLength(1);
    });

    it("doesn't add the email when the record already has it", async () => {
      findRecordTE.mockResolvedValue({
        status: 200,
        result: makePersonRecord({
          email_addresses: [{ email: "other@example.com" }, { email: "jane@example.com" }],
        }),
      });

      await submit(TOKEN, form());

      expect(updateRecordTE.mock.calls[0][2]).not.toHaveProperty("email_addresses_attributes");
    });

    it("compares emails case-sensitively (current behaviour)", async () => {
      findRecordTE.mockResolvedValue({
        status: 200,
        result: makePersonRecord({ email_addresses: [{ email: "JANE@example.com" }] }),
      });

      await submit(TOKEN, form());

      // A differently-cased duplicate is treated as a new email
      expect(updateRecordTE.mock.calls[0][2]).toHaveProperty("email_addresses_attributes");
    });

    it("throws if the record has no email_addresses list (current behaviour)", async () => {
      findRecordTE.mockResolvedValue({ status: 200, result: { id: 99 } });

      await expect(submit(TOKEN, form())).rejects.toThrow(TypeError);
      expect(updateRecordTE).not.toHaveBeenCalled();
    });
  });

  // ---- Validation -----------------------------------------------------------
  describe("validation", () => {
    it.each(BASE_FORM_FIELDS)("returns 400 when %s is missing", async (field) => {
      const result = await submit(TOKEN, form({ omit: [field] }));

      expect(result).toEqual({ id: "sub-123", status: 400, message: `Missing fields: ${field}, ` });
      expectNoTopEchelonCalls();
    });

    it("lists every missing field", async () => {
      const result = await submit(TOKEN, form({ omit: ["fname", "email", "city"] }));

      expect(result.status).toBe(400);
      expect(result.message).toBe("Missing fields: fname, email, city, ");
    });

    it("returns 400 when the resume is not a file", async () => {
      const result = await submit(TOKEN, form({ overrides: { resume: "just some text" } }));

      expect(result).toEqual({ id: "sub-123", status: 400, message: "File missing" });
      expectNoTopEchelonCalls();
    });

    it.each([
      "https://example.com/in/janedoe",
      "https://www.linkedin.com/company/acme",
      "not a url",
      "",
    ])("returns 400 for a malformed LinkedIn link (%j)", async (linkedIn) => {
      const result = await submit(TOKEN, form({ overrides: { linkedIn } }));

      expect(result).toEqual({
        id: "sub-123",
        status: 400,
        message: "Link to LinkedIn profile is malformed",
      });
      expectNoTopEchelonCalls();
    });

    it("accepts a LinkedIn profile link without https://", async () => {
      const result = await submit(TOKEN, form({ overrides: { linkedIn: "www.linkedin.com/in/janedoe" } }));

      expect(result.status).toBe(200);
    });

    it("rejects LinkedIn links without 'www.' (current behaviour)", async () => {
      const result = await submit(TOKEN, form({ overrides: { linkedIn: "https://linkedin.com/in/janedoe" } }));

      expect(result.status).toBe(400);
    });

    it("accepts blank text fields as long as they are present (current behaviour)", async () => {
      const result = await submit(TOKEN, form({ overrides: { fname: "", city: "" } }));

      expect(result.status).toBe(200);
    });
  });

  // ---- Failure mapping ------------------------------------------------------
  describe("when a step fails", () => {
    it.each([400, 422, 500])("passes through a resume parse failure (%i)", async (status) => {
      parseFromResumeTE.mockResolvedValue(status);

      const result = await submit(TOKEN, form());

      expect(result).toEqual({ id: "sub-123", status, message: "Parse error" });
      expect(findRecordTE).not.toHaveBeenCalled();
      expect(updateRecordTE).not.toHaveBeenCalled();
    });

    it.each([404, 500])("passes through a search failure (%i)", async (status) => {
      findRecordTE.mockResolvedValue({ status, message: "Search error", result: null });

      const result = await submit(TOKEN, form());

      expect(result).toEqual({ id: "sub-123", status, message: "Search error" });
      expect(updateRecordTE).not.toHaveBeenCalled();
      expect(addAttachmentTE).not.toHaveBeenCalled();
      expect(addToHotlistTE).not.toHaveBeenCalled();
    });

    it.each([404, 422, 500])("passes through an update failure (%i)", async (status) => {
      updateRecordTE.mockResolvedValue(status);

      const result = await submit(TOKEN, form());

      expect(result).toEqual({ id: "sub-123", status, message: "Update error" });
      expect(addAttachmentTE).not.toHaveBeenCalled();
      expect(addToHotlistTE).not.toHaveBeenCalled();
    });

    it.each([400, 413, 500])("passes through an attachment failure (%i)", async (status) => {
      addAttachmentTE.mockResolvedValue(status);

      const result = await submit(TOKEN, form());

      expect(result).toEqual({ id: "sub-123", status, message: "Attachment error" });
      expect(addToHotlistTE).not.toHaveBeenCalled();
    });

    it("passes through the status and message of a hotlist failure", async () => {
      addToHotlistTE.mockResolvedValue({ status: 401, message: "Authentication error" });

      const result = await submit(TOKEN, form());

      expect(result).toEqual({ id: "sub-123", status: 401, message: "Authentication error" });
    });

    it("always returns the submission id", async () => {
      uid.mockReturnValue("unique-xyz");
      parseFromResumeTE.mockResolvedValue(500);

      const result = await submit(TOKEN, form());

      expect(result.id).toBe("unique-xyz");
    });

    it("generates a fresh id per submission", async () => {
      uid.mockReturnValueOnce("first").mockReturnValueOnce("second");

      const a = await submit(TOKEN, form());
      const b = await submit(TOKEN, form());

      expect([a.id, b.id]).toEqual(["first", "second"]);
    });
  });
});

// =============================================================================
// fractionalSubmission only
// =============================================================================
describe("fractionalSubmission (fractional-only behaviour)", () => {
  const form = (opts = {}) => buildFormData({ type: "fractional", ...opts });

  it.each(FRACTIONAL_FORM_FIELDS)("returns 400 when %s is missing", async (field) => {
    const result = await fractionalSubmission(TOKEN, form({ omit: [field] }));

    expect(result).toEqual({ id: "sub-123", status: 400, message: `Missing fields: ${field}, ` });
    expect(parseFromResumeTE).not.toHaveBeenCalled();
  });

  it("lists base fields before fractional fields when both are missing", async () => {
    const result = await fractionalSubmission(TOKEN, form({ omit: ["jobTitle", "fname"] }));

    expect(result.message).toBe("Missing fields: fname, jobTitle, ");
  });

  it.each(["On site/In office", "Hybrid", "Remote"])(
    "accepts the work preference %j",
    async (workTypePreference) => {
      const result = await fractionalSubmission(TOKEN, form({ overrides: { workTypePreference } }));

      expect(result.status).toBe(200);
    }
  );

  it.each(["remote", "Anywhere", ""])("rejects the work preference %j", async (workTypePreference) => {
    const result = await fractionalSubmission(TOKEN, form({ overrides: { workTypePreference } }));

    expect(result).toEqual({
      id: "sub-123",
      status: 400,
      message: "Invalid option chosen for work type preference.",
    });
    expect(parseFromResumeTE).not.toHaveBeenCalled();
  });

  it("adds the current job to the update", async () => {
    await fractionalSubmission(TOKEN, form());

    expect(updateRecordTE.mock.calls[0][2].work_history_update).toEqual({
      title: "VP Engineering",
      description: "Led the engineering org",
      company_name: "Acme Corp",
      is_present_job: true,
    });
  });

  it("includes the fractional answers in the responses file", async () => {
    await fractionalSubmission(TOKEN, form());

    const text = await addAttachmentTE.mock.calls[0][2].text();
    expect(text).toContain("Job Title: VP Engineering");
    expect(text).toContain("Industry: SaaS");
    expect(text).toContain("Company: Acme Corp");
    expect(text).toContain("Boss: The CEO");
    expect(text).toContain("Led the engineering org");
    expect(text).toContain("Platform and Data");
    expect(text).toContain("Scaling the platform");
    expect(text).toContain("Rebuilt the CI pipeline");
    expect(text).toContain("Cut cloud costs by 20%");
    expect(text).toContain("Distributed systems");
    expect(text).toContain("AWS, Kubernetes");
    expect(text).toContain("Fractional CTO roles");
    expect(text).toContain("Early-stage startups");
    expect(text).toContain("Work Preference: Remote");
  });
});

// =============================================================================
// advisorySubmission only
// =============================================================================
describe("advisorySubmission (advisory-only behaviour)", () => {
  const form = (opts = {}) => buildFormData({ type: "advisory", ...opts });

  it("doesn't require any of the fractional questions", async () => {
    const result = await advisorySubmission(TOKEN, form());

    expect(result.status).toBe(200);
  });

  it("doesn't validate the work type preference", async () => {
    const result = await advisorySubmission(TOKEN, form({ overrides: { workTypePreference: "Nonsense" } }));

    expect(result.status).toBe(200);
  });

  it("doesn't add job history to the update", async () => {
    await advisorySubmission(TOKEN, form());

    expect(updateRecordTE.mock.calls[0][2]).not.toHaveProperty("work_history_update");
  });
});