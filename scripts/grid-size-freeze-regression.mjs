import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const port = Number(process.env.GRID_FREEZE_TEST_PORT ?? 4180);
const host = "127.0.0.1";

function loadPlaywright() {
  return require("playwright");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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
  await input.evaluate((element, value) => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(element, String(value));
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
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
  }
  await details.evaluate((element) => {
    element.open = false;
  });
}

async function shiftClickMap(page, xRatio, yRatio) {
  const box = await page.locator(".map").boundingBox();
  assert(box, "map bounding box is available");
  await page.keyboard.down("Shift");
  try {
    await page.mouse.click(box.x + box.width * xRatio, box.y + box.height * yRatio);
  } finally {
    await page.keyboard.up("Shift");
  }
}

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

  await setBuildings(page, true);
  state = await waitForCoverage(page, state.renderSequence);

  for (const gridSize of [96, 192, 384, 128, 320, 100]) {
    await setGridSize(page, gridSize);
  }
  state = await waitForCoverage(page, state.renderSequence);

  const before = state;
  await shiftClickMap(page, 0.57, 0.46);
  const after = await waitForCoverage(page, before.renderSequence);

  assert(
    JSON.stringify(after.coverageCoordinates) !== JSON.stringify(before.coverageCoordinates),
    "operator move should move coverage coordinates after grid-size changes with buildings enabled",
  );
  assert(
    after.coverageCanvasFingerprint !== before.coverageCanvasFingerprint,
    "operator move should redraw coverage pixels after grid-size changes with buildings enabled",
  );
} finally {
  await browser?.close();
  await server.close();
}
