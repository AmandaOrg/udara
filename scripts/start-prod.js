/**
 * Production boot: apply migrations, compile if Railway did not keep dist/,
 * then start the compiled app. Used by `npm run start:prod`.
 */
const { existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");

function compiledEntry() {
  if (existsSync("dist/main.js")) return "dist/main.js";
  if (existsSync("dist/src/main.js")) return "dist/src/main.js";
  return null;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status) process.exit(result.status);
}

run("npx", ["prisma", "migrate", "deploy"]);

let entry = compiledEntry();
if (!entry) {
  run("npm", ["run", "build"]);
  entry = compiledEntry();
}
if (!entry) {
  console.error(
    "start:prod: nest build did not emit dist/main.js (or dist/src/main.js)",
  );
  process.exit(1);
}

run(process.execPath, [entry]);
