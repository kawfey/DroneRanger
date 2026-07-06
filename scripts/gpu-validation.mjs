import { createRequire } from "node:module";
import { join } from "node:path";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const port = Number(process.env.GPU_TEST_PORT ?? 5177);
const host = "127.0.0.1";
const validationTimeoutMs = Number(process.env.GPU_TEST_TIMEOUT_MS ?? 45000);

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

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => {
    console.error(error);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      console.error(message.text());
    }
  });

  await page.goto(`http://${host}:${port}/gpu-validation.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.runGpuCoverageValidation));

  const results = await withTimeout(
    page.evaluate(() => window.runGpuCoverageValidation?.()),
    validationTimeoutMs,
    "GPU validation",
  );

  console.table(results);
  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    throw new Error(`${failed.length} GPU validation scenario(s) failed`);
  }
} finally {
  await browser?.close();
  await server.close();
}
