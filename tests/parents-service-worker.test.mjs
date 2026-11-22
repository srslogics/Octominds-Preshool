import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const source = await readFile(
  new URL("../public/sw.js", import.meta.url),
  "utf8",
);
function worker({ offline = false } = {}) {
  const handlers = {},
    matched = [],
    fetched = [];
  const context = {
    URL,
    self: {
      location: { origin: "https://school.test" },
      addEventListener: (name, fn) => (handlers[name] = fn),
    },
    caches: {
      match: async (key) => {
        matched.push(key);
        return { shell: key };
      },
    },
    fetch: async (req) => {
      fetched.push(req);
      if (offline) throw Error("offline");
      return { ok: true };
    },
  };
  vm.runInNewContext(source, context);
  return {
    matched,
    fetched,
    async request(path, mode = "cors") {
      let response;
      handlers.fetch({
        request: { method: "GET", url: "https://school.test" + path, mode },
        respondWith: (p) => (response = p),
      });
      return await response;
    },
  };
}
test("parent data and runtime config never fall back to a cached response", async () => {
  for (const path of [
    "/api/v1/parents/workspace",
    "/api/v1/parents/photos/id/image?thumbnail=true",
    "/api/v1/parents/children/id/messages",
    "/config.js",
    "/ready",
  ]) {
    const sw = worker({ offline: true });
    await assert.rejects(sw.request(path));
    assert.equal(sw.fetched.length, 1);
    assert.deepEqual(sw.matched, []);
  }
});
test("offline parent navigation uses the parent shell", async () => {
  const sw = worker({ offline: true });
  assert.equal(
    (await sw.request("/parents?preview=1", "navigate")).shell,
    "/parents",
  );
});
test("offline school and inventory retain their own shells", async () => {
  const sw = worker({ offline: true });
  assert.equal((await sw.request("/school", "navigate")).shell, "/school");
  assert.equal((await sw.request("/", "navigate")).shell, "/");
});
