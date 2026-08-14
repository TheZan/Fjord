import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RECORD_SCHEMA_VERSION = 2;
const REPORT_SCHEMA_VERSION = 1;

async function jsonFiles(directory, optional) {
  if (!directory) return [];

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (optional && error?.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await jsonFiles(path, optional)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(path);
    }
  }
  return files.sort();
}

export async function readBenchmarkRecords(directory, { optional = false } = {}) {
  const records = [];
  for (const path of await jsonFiles(directory, optional)) {
    const record = JSON.parse(await readFile(path, "utf8"));
    if (record.schemaVersion !== RECORD_SCHEMA_VERSION || !record.scenario) continue;
    records.push({ path, record });
  }
  return records;
}

function comparisonIdentity(record) {
  return {
    fixture: record.fixture?.hash ?? "",
    os: record.environment?.os ?? "",
    arch: record.environment?.arch ?? "",
    profile: record.environment?.profile ?? "",
    cacheState: record.cacheState ?? "unknown",
    warmups: record.sampling?.warmups ?? 0,
    repetitions: record.sampling?.repetitions ?? 0,
  };
}

function incompatibilities(current, baseline) {
  const currentIdentity = comparisonIdentity(current);
  const baselineIdentity = comparisonIdentity(baseline);
  return Object.keys(currentIdentity)
    .filter((field) => currentIdentity[field] !== baselineIdentity[field])
    .map(
      (field) =>
        `${field}: ${currentIdentity[field]} vs ${baselineIdentity[field]}`,
    );
}

function metricValue(metric) {
  return typeof metric?.p95 === "number" ? metric.p95 : metric?.value;
}

function metricDeltas(current, baseline) {
  const deltas = [];
  for (const [name, metric] of Object.entries(current.metrics ?? {})) {
    if (metric.unit === "count") continue;

    const previous = baseline.metrics?.[name];
    if (!previous || previous.unit !== metric.unit) {
      deltas.push({ name, unit: metric.unit, status: "no_metric_baseline" });
      continue;
    }

    const value = metricValue(metric);
    const baselineValue = metricValue(previous);
    if (typeof value !== "number" || typeof baselineValue !== "number") continue;

    deltas.push({
      name,
      unit: metric.unit,
      statistic: typeof metric.p95 === "number" ? "p95" : "value",
      value,
      baselineValue,
      delta: value - baselineValue,
      percent: baselineValue === 0 ? null : ((value - baselineValue) / baselineValue) * 100,
      status: "compared",
    });
  }
  return deltas;
}

export function buildBenchmarkReport(
  currentEntries,
  baselineEntries,
  { generatedAt = new Date().toISOString() } = {},
) {
  const comparisons = currentEntries
    .map(({ record: current }) => {
      const candidates = baselineEntries.filter(
        ({ record }) => record.scenario === current.scenario,
      );
      const comparable = candidates.find(
        ({ record }) => incompatibilities(current, record).length === 0,
      );

      if (comparable) {
        return {
          scenario: current.scenario,
          status: "compared",
          metrics: metricDeltas(current, comparable.record),
        };
      }
      if (candidates.length === 0) {
        return { scenario: current.scenario, status: "no_baseline", metrics: [] };
      }
      return {
        scenario: current.scenario,
        status: "not_comparable",
        reasons: incompatibilities(current, candidates[0].record),
        metrics: [],
      };
    })
    .sort((left, right) => left.scenario.localeCompare(right.scenario));

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt,
    records: currentEntries.map(({ record }) => record),
    comparisons,
  };
}

function markdownCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function number(value) {
  return Number(value).toFixed(3);
}

export function renderMarkdown(report) {
  const lines = [
    "## Performance regression report",
    "",
    "Reporting only: regressions are visible here but do not fail the workflow.",
    "",
    "| Scenario | Metric | Current | Previous | Delta |",
    "|---|---|---:|---:|---:|",
  ];

  for (const comparison of report.comparisons) {
    if (comparison.status === "no_baseline") {
      lines.push(`| ${markdownCell(comparison.scenario)} | _no previous baseline_ | — | — | — |`);
      continue;
    }
    if (comparison.status === "not_comparable") {
      lines.push(
        `| ${markdownCell(comparison.scenario)} | _not comparable: ${markdownCell(comparison.reasons.join("; "))}_ | — | — | — |`,
      );
      continue;
    }
    if (comparison.metrics.length === 0) {
      lines.push(`| ${markdownCell(comparison.scenario)} | _no comparable metrics_ | — | — | — |`);
      continue;
    }

    for (const metric of comparison.metrics) {
      if (metric.status !== "compared") {
        lines.push(
          `| ${markdownCell(comparison.scenario)} | ${markdownCell(metric.name)} | — | — | _no metric baseline_ |`,
        );
        continue;
      }
      const percent = metric.percent === null ? "n/a" : `${metric.percent >= 0 ? "+" : ""}${metric.percent.toFixed(1)}%`;
      lines.push(
        `| ${markdownCell(comparison.scenario)} | ${markdownCell(metric.name)} (${metric.statistic}) | ${number(metric.value)} ${metric.unit} | ${number(metric.baselineValue)} ${metric.unit} | ${percent} |`,
      );
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`expected --name value, got ${flag ?? "end of input"}`);
    }
    args[flag.slice(2)] = value;
  }
  for (const required of ["current", "markdown", "json"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

async function writeText(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const current = await readBenchmarkRecords(args.current);
  if (current.length === 0) throw new Error(`no benchmark records found in ${args.current}`);
  const baseline = await readBenchmarkRecords(args.baseline, { optional: true });
  const report = buildBenchmarkReport(current, baseline);
  await writeText(args.markdown, renderMarkdown(report));
  await writeText(args.json, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Compared ${current.length} scenario(s) with ${baseline.length} baseline record(s).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
