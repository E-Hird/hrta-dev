import { vi } from "vitest";

/**
 * Tiny fetch mock: register expected requests, each with a queue of responses.
 * - Unmatched requests throw (so a forgotten mock fails loudly).
 * - Every recorded call is available in `calls` for asserting headers/bodies.
 * - `assertAllConsumed()` fails if a registered response was never used.
 */
export function createFetchMock() {
  const routes = [];
  const calls = [];

  const impl = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init.method || "GET").toUpperCase();
    const headers = new Headers(init.headers || {});
    calls.push({ url, method, headers, body: init.body });

    const route = routes.find(
      (r) => r.method === method && r.matches(url) && r.queue.length > 0
    );
    if (!route) throw new Error(`Unmocked fetch: ${method} ${url.href}`);

    const spec = route.queue.shift();
    const raw = typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body ?? {});
    return new Response(spec.status === 204 ? null : raw, {
      status: spec.status,
      headers: spec.headers,
    });
  };

  const fn = vi.fn(impl);

  /**
   * @param {string} method
   * @param {string} urlNoQuery  e.g. "https://api.notion.com/v1/pages"
   * @param {Array}  responses   [{ status, body, headers }, ...] used in order
   * @param {Object} [query]     query params that must be present (strings)
   */
  function on(method, urlNoQuery, responses, query) {
    const target = new URL(urlNoQuery);
    routes.push({
      method: method.toUpperCase(),
      queue: [...responses],
      matches: (u) =>
        u.origin === target.origin &&
        u.pathname === target.pathname &&
        (!query || Object.entries(query).every(([k, v]) => u.searchParams.get(k) === String(v))),
    });
  }

  return {
    fn,
    calls,
    on,
    install: () => vi.stubGlobal("fetch", fn),
    callsTo: (method, pathname) =>
      calls.filter((c) => c.method === method && c.url.pathname === pathname),
    assertAllConsumed() {
      const left = routes.filter((r) => r.queue.length > 0);
      if (left.length) throw new Error(`${left.length} mocked response(s) never used`);
    },
  };
}

export const ok = (body = {}, headers) => ({ status: 200, body, headers });
export const reply = (status, body = {}, headers) => ({ status, body, headers });