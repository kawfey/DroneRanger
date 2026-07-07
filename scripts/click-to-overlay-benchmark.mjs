import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const port = Number(process.env.COVERAGE_BENCH_PORT ?? 5179);
const host = "127.0.0.1";
const gridSizes = (process.env.COVERAGE_BENCH_GRIDS ?? "100,192,384").split(",").map(Number);
const repetitions = Number(process.env.COVERAGE_BENCH_REPETITIONS ?? 5);

function loadPlaywright() {
  try {
    return require("playwright");
  } catch {
    const home = process.env.USERPROFILE ?? process.env.HOME;
    if (!home) {
      throw new Error("Playwright is not installed and no home directory was found for bundled lookup");
    }
    return require(join(home, ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"));
  }
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? null;
}

function roundedPercentile(values, p) {
  const value = percentile(values, p);
  return value === null ? null : Math.round(value);
}

async function debugState(page) {
  return page.evaluate(() => JSON.parse(JSON.stringify(window.__droneRangeDebug ?? null)));
}

async function waitForCoverage(page, previousSequence = -1) {
  await page.waitForFunction(
    (sequence) => {
      const debug = window.__droneRangeDebug;
      return Boolean(
        debug?.hasCoverageSource &&
          debug.coverageCanvasFingerprint &&
          debug.coverageCoordinates &&
          debug.lastCoverageTimings &&
          debug.renderSequence > sequence,
      );
    },
    previousSequence,
    { timeout: 90000 },
  );
  return debugState(page);
}

async function setGridSize(page, gridSize) {
  const input = page.locator('label:has-text("Grid resolution") input[type="range"]').first();
  return input.evaluate((element, value) => {
    if (Number(element.value) === value) {
      return false;
    }
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(element, String(value));
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, gridSize);
}

async function setBuildings(page, enabled) {
  const details = page.locator("details.config-menu").first();
  await details.evaluate((element) => {
    element.open = true;
  });
  const input = page.locator('label:has-text("Building occlusion") input[type="checkbox"]').first();
  const checked = await input.isChecked();
  if (checked !== enabled) {
    await input.click();
    return true;
  }
  return false;
}

async function shiftClickMap(page, xRatio, yRatio) {
  const box = await page.locator(".map").boundingBox();
  if (!box) {
    throw new Error("map bounding box is unavailable");
  }
  await page.keyboard.down("Shift");
  try {
    await page.mouse.click(box.x + box.width * xRatio, box.y + box.height * yRatio);
  } finally {
    await page.keyboard.up("Shift");
  }
}

const clickPath = [
  [0.51, 0.49],
  [0.53, 0.48],
  [0.52, 0.51],
  [0.49, 0.5],
  [0.5, 0.47],
  [0.54, 0.5],
];

const server = await createServer({
  server: {
    host,
    port,
    strictPort: true,
  },
  logLevel: "error",
});

let browser;

try {
  await server.listen();
  const { chromium } = loadPlaywright();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.setDefaultTimeout(30000);

  await page.goto(`http://${host}:${port}`, { waitUntil: "domcontentloaded" });
  let state = await waitForCoverage(page);
  const results = [];

  for (const includeBuildings of [false, true]) {
    if (await setBuildings(page, includeBuildings)) {
      state = await waitForCoverage(page, state.renderSequence);
    }
    for (const gridSizePx of gridSizes) {
      if (await setGridSize(page, gridSizePx)) {
        state = await waitForCoverage(page, state.renderSequence);
      }

      const samples = [];
      const renderSamples = [];
      const updateSamples = [];
      const demBuildSamples = [];
      const buildingBuildSamples = [];
      for (let index = 0; index < repetitions; index++) {
        const [xRatio, yRatio] = clickPath[index % clickPath.length];
        const beforeSequence = state.renderSequence;
        const startedAt = performance.now();
        await shiftClickMap(page, xRatio, yRatio);
        state = await waitForCoverage(page, beforeSequence);
        samples.push(performance.now() - startedAt);
        const timings = state.lastCoverageTimings ?? {};
        if (Number.isFinite(timings.totalMs)) {
          renderSamples.push(timings.totalMs);
        }
        if (Number.isFinite(timings.updateAnalysisMs)) {
          updateSamples.push(timings.updateAnalysisMs);
        }
        if (Number.isFinite(timings.demBuildMs)) {
          demBuildSamples.push(timings.demBuildMs);
        }
        if (Number.isFinite(timings.buildingBuildMs)) {
          buildingBuildSamples.push(timings.buildingBuildMs);
        }
      }

      results.push({
        buildings: includeBuildings ? "on" : "off",
        gridSizePx,
        samples: samples.length,
        medianMs: roundedPercentile(samples, 50),
        p95Ms: roundedPercentile(samples, 95),
        renderMedianMs: roundedPercentile(renderSamples, 50),
        updateMedianMs: roundedPercentile(updateSamples, 50),
        demBuildMedianMs: roundedPercentile(demBuildSamples, 50),
        buildingBuildMedianMs: roundedPercentile(buildingBuildSamples, 50),
      });
    }
  }

  console.table(results);
} finally {
  await browser?.close();
  await server.close();
}
