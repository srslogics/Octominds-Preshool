import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(resolve(root, "public"), dist, { recursive: true });

const html = await readFile(resolve(dist, "index.html"), "utf8");
for (const marker of ["OctoMinds Inventory", "loginForm", "inventoryPage"]) {
  if (!html.includes(marker)) throw new Error(`Missing required marker: ${marker}`);
}
console.log("OctoMinds Inventory static assets created in dist/");
