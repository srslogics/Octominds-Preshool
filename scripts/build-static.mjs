import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, "server"), { recursive: true });
await mkdir(resolve(dist, "client"), { recursive: true });
await mkdir(resolve(dist, ".openai"), { recursive: true });
await cp(resolve(root, "public"), resolve(dist, "client"), { recursive: true });
await cp(resolve(root, ".openai", "hosting.json"), resolve(dist, ".openai", "hosting.json"));

const worker = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let response = await env.ASSETS.fetch(request);
    if (response.status === 404 && !url.pathname.includes('.')) {
      response = await env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));
    }
    return response;
  }
};\n`;
await writeFile(resolve(dist, "server", "index.js"), worker);

const html = await readFile(resolve(dist, "client", "index.html"), "utf8");
for (const marker of ["OctoMinds", "loginForm", "appView"]) {
  if (!html.includes(marker)) throw new Error(`Missing required marker: ${marker}`);
}
console.log("OctoMinds static build created in dist/");
