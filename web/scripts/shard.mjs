// Runs one of N e2e shards balanced by test time; Playwright's own --shard splits by test count, which leaves the
// long transfer and reconnect specs on one runner.
//   node scripts/shard.mjs <current>/<total> [playwright test args]   list the tests, give each shard an even share
//                                                                     of tests/e2e/durations.json, run this one
//   node scripts/shard.mjs record <report.json>...                    merge the times of JSON reports (CI uploads
//                                                                     one per shard as e2e-times-<n>) into it
// A test missing from durations.json counts as DEFAULT_SECONDS, so a stale file costs balance, never coverage.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const DURATIONS = new URL("../tests/e2e/durations.json", import.meta.url);
const DEFAULT_SECONDS = 5;

/** Every spec of a JSON report as { key, location, seconds }; the key is its file and title path. */
const specsOf = (report) => {
  const specs = [];
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      const seconds = spec.tests.reduce((sum, run) => sum + (run.results?.at(-1)?.duration ?? 0) / 1000, 0);
      const location = relative(process.cwd(), join(report.config.rootDir, `${spec.file}:${spec.line}`));
      specs.push({ key: [spec.file, ...titles, spec.title].join(" › "), location, seconds });
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  for (const file of report.suites) walk(file, []);

  return specs;
};

const readDurations = () => JSON.parse(readFileSync(DURATIONS, "utf8"));

const [command, ...rest] = process.argv.slice(2);

if (command === "record") {
  const durations = readDurations();
  // Half old, half new: the long transfer specs swing by a third between runs, and one run should not move them all.
  for (const path of rest)
    for (const spec of specsOf(JSON.parse(readFileSync(path, "utf8"))))
      if (spec.seconds > 0)
        durations[spec.key] = Math.round(((durations[spec.key] ?? spec.seconds) + spec.seconds) * 5) / 10;
  const sorted = Object.fromEntries(Object.entries(durations).toSorted(([a], [b]) => a.localeCompare(b)));
  writeFileSync(DURATIONS, `${JSON.stringify(sorted, null, 2)}\n`);
  process.exit(0);
}

const [current, total] = (command ?? "").split("/").map(Number);
if (!(total >= 1 && current >= 1 && current <= total)) {
  console.error("usage: node scripts/shard.mjs <current>/<total> [playwright test args] | record <report.json>...");
  process.exit(2);
}

const listed = execFileSync("npx", ["playwright", "test", "--list", "--reporter=json", ...rest], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const durations = readDurations();

// The CLI selects tests by file:line, so tests declared on one line (a loop) travel together.
const groups = new Map();
for (const spec of specsOf(JSON.parse(listed)))
  groups.set(spec.location, (groups.get(spec.location) ?? 0) + (durations[spec.key] ?? DEFAULT_SECONDS));

// Longest first, each to the emptiest shard: no shard ends more than its last group over the others.
const shards = Array.from({ length: total }, () => ({ seconds: 0, locations: [] }));
for (const [location, seconds] of [...groups].toSorted(([la, a], [lb, b]) => b - a || la.localeCompare(lb))) {
  const emptiest = shards.reduce((min, shard) => (shard.seconds < min.seconds ? shard : min));
  emptiest.seconds += seconds;
  emptiest.locations.push(location);
}

console.log(`shards by expected seconds: ${shards.map((shard) => Math.round(shard.seconds)).join(" / ")}`);
const mine = shards[current - 1].locations;
if (mine.length === 0) process.exit(0);

const run = spawnSync("npx", ["playwright", "test", ...rest, ...mine], { stdio: "inherit" });
process.exit(run.status ?? 1);
