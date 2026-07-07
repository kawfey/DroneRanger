import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const port = Number(process.env.COVERAGE_BENCH_PORT ?? 5179);
const host = "127.0.0.1";
const gridSizes = (process.env.COVERAGE_BENCH_GRIDS ?? "100,192,384").split(",").map(Number);
const repetitions = Number(process.env.COVERAGE_BENCH_REPETITIONS ?? 7);

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
  const finite = values.filter(Number.isFinite);
  const sorted = [...finite].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? null;
}

function median(values) {
  const value = percentile(values, 50);
  return value === null ? null : Math.round(value);
}

function p95(values) {
  const value = percentile(values, 95);
  return value === null ? null : Math.round(value);
}

function phase(timings, name) {
  return Number.isFinite(timings?.[name]) ? timings[name] : null;
}

function summarizedSample(sample) {
  const timings = sample.timings ?? {};
  const actionToOverlayMs = phase(timings, "actionToOverlayMs") ?? sample.wallMs;
  const updateAnalysisMs = phase(timings, "updateAnalysisMs") ?? 0;
  const renderMs = phase(timings, "gpuDrawMs") ?? phase(timings, "renderMs") ?? phase(timings, "totalMs") ?? 0;
  const overlayApplyMs = phase(timings, "overlayApplyMs") ?? 0;
  return {
    ...sample,
    actionToOverlayMs,
    unattributedMs: Math.max(0, actionToOverlayMs - updateAnalysisMs - renderMs - overlayApplyMs),
  };
}

function summarize(action, buildings, gridSizePx, samples) {
  const rows = samples.map(summarizedSample);
  return {
    action,
    buildings,
    gridSizePx,
    samples: rows.length,
    wallMedianMs: median(rows.map((sample) => sample.wallMs)),
    wallP95Ms: p95(rows.map((sample) => sample.wallMs)),
    actionToOverlayMedianMs: median(rows.map((sample) => sample.actionToOverlayMs)),
    updateMedianMs: median(rows.map((sample) => phase(sample.timings, "updateAnalysisMs"))),
    demBuildMedianMs: median(rows.map((sample) => phase(sample.timings, "demBuildMs"))),
    buildingBuildMedianMs: median(rows.map((sample) => phase(sample.timings, "buildingBuildMs"))),
    buildingFetchParseMedianMs: median(rows.map((sample) => phase(sample.timings, "buildingFetchParseMs"))),
    buildingRasterizeMedianMs: median(rows.map((sample) => phase(sample.timings, "buildingRasterizeMs"))),
    combineMedianMs: median(rows.map((sample) => phase(sample.timings, "combineMs"))),
    uploadMedianMs: median(rows.map((sample) => phase(sample.timings, "demUploadMs"))),
    gpuDrawMedianMs: median(rows.map((sample) => phase(sample.timings, "gpuDrawMs"))),
    overlayMedianMs: median(rows.map((sample) => phase(sample.timings, "overlayApplyMs"))),
    displayCopyMedianMs: median(rows.map((sample) => phase(sample.timings, "displayCopyMs"))),
    mapSourceMedianMs: median(rows.map((sample) => phase(sample.timings, "mapSourceUpdateMs"))),
    fingerprintMedianMs: median(rows.map((sample) => phase(sample.timings, "fingerprintMs"))),
    unattributedMedianMs: median(rows.map((sample) => sample.unattributedMs)),
  };
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

async function startBrowserTiming(page) {
  await page.evaluate(() => {
    window.__coverageBenchmarkStartedAt = performance.now();
  });
}

async function sampleAction(page, state, action) {
  const beforeSequence = state.renderSequence;
  await startBrowserTiming(page);
  const startedAt = performance.now();
  await action();
  const nextState = await waitForCoverage(page, beforeSequence);
  return {
    state: nextState,
    sample: {
      wallMs: performance.now() - startedAt,
      timings: nextState.lastCoverageTimings ?? {},
    },
  };
}

const clickPath = [
  [0.51, 0.49],
  [0.53, 0.48],
  [0.52, 0.51],
  [0.49, 0.5],
  [0.5, 0.47],
  [0.54, 0.5],
  [0.48, 0.48],
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
  const summaries = [];
  const raw = [];

  for (const includeBuildings of [false, true]) {
    if (await setBuildings(page, includeBuildings)) {
      state = await waitForCoverage(page, state.renderSequence);
    }
    const buildings = includeBuildings ? "on" : "off";

    for (const gridSizePx of gridSizes) {
      if (await setGridSize(page, gridSizePx)) {
        state = await waitForCoverage(page, state.renderSequence);
      }

      const moveSamples = [];
      for (let index = 0; index < repetitions; index++) {
        const [xRatio, yRatio] = clickPath[index % clickPath.length];
        const result = await sampleAction(page, state, () => shiftClickMap(page, xRatio, yRatio));
        state = result.state;
        moveSamples.push(result.sample);
      }
      summaries.push(summarize("operator-move", buildings, gridSizePx, moveSamples));
      raw.push({ action: "operator-move", buildings, gridSizePx, samples: moveSamples });

      const gridSamples = [];
      const warmupGridSize = gridSizePx === gridSizes[0] ? gridSizePx + 1 : gridSizePx - 1;
      for (let index = 0; index < repetitions; index++) {
        if (await setGridSize(page, warmupGridSize)) {
          state = await waitForCoverage(page, state.renderSequence);
        }
        const result = await sampleAction(page, state, () => setGridSize(page, gridSizePx));
        state = result.state;
        gridSamples.push(result.sample);
      }
      summaries.push(summarize("grid-change", buildings, gridSizePx, gridSamples));
      raw.push({ action: "grid-change", buildings, gridSizePx, samples: gridSamples });
    }
  }

  console.table(summaries);
  if (process.env.COVERAGE_BENCH_RAW === "1") {
    console.log(JSON.stringify(raw, null, 2));
  }
} finally {
  await browser?.close();
  await server.close();
}
