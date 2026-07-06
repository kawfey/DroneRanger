import { createRequire } from "node:module";
import { join } from "node:path";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const port = Number(process.env.OPERATOR_MOVE_TEST_PORT ?? 4178);
const host = "127.0.0.1";

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
    { timeout: 60000 },
  );
  return debugState(page);
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
  const before = await waitForCoverage(page);

  await shiftClickMap(page, 0.68, 0.44);
  const after = await waitForCoverage(page, before.renderSequence);

  assert(
    JSON.stringify(after.coverageCoordinates) !== JSON.stringify(before.coverageCoordinates),
    "operator move should move coverage coordinates",
  );
  assert(
    after.coverageCanvasFingerprint !== before.coverageCanvasFingerprint,
    "operator move should redraw coverage pixels, not just move the old canvas texture",
  );
} finally {
  await browser?.close();
  await server.close();
}
