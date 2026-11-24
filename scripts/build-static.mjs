import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(resolve(root, "public"), dist, { recursive: true });

const pages = [
  ["inventory", ["index.html"], ["OctoMinds Inventory", "loginForm", "inventoryPage"]],
  ["school", ["school/index.html", "school.html"], ["signInForm"]],
  ["parents", ["parents/index.html", "parents.html"], ["childSelect"]],
  ["teachers", ["teachers/index.html", "teachers.html"], ["teacherClass"]],
];
for (const [app, locations, markers] of pages) {
  const entry = resolve(dist, "apps", app, "index.html");
  const html = await readFile(entry, "utf8");
  for (const marker of markers) {
    if (!html.includes(marker)) throw new Error(`${app}: missing required marker ${marker}`);
  }
  for (const location of locations) {
    const destination = resolve(dist, location);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await cp(entry, destination);
  }
}
console.log("OctoMinds Inventory, School, Parent Portal, and Teacher App built in dist/");
