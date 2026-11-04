import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = fileURLToPath(new URL("./.tmp-test/", import.meta.url));
const tests = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join(testDir, name));

if (tests.length === 0) {
  console.error("No bundled frontend tests found.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...tests], {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
