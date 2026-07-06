import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { join } from "node:path";

const require = createRequire(import.meta.url);

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

function waitForServer(url, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) {
          resolve();
          return;
        }
      } catch {
        // Server is still starting.
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

const port = 5177;
const baseUrl = `http://127.0.0.1:${port}`;
const serverCommand =
  process.platform === "win32"
    ? ["cmd.exe", ["/d", "/s", "/c", "pnpm exec vite --host 127.0.0.1 --port 5177 --strictPort"]]
    : ["pnpm", ["exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"]];
const server = spawn(serverCommand[0], serverCommand[1], {
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
});

let stderr = "";
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  await waitForServer(`${baseUrl}/gpu-validation.html`);
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/gpu-validation.html`, { waitUntil: "networkidle" });
    const results = await page.evaluate(async () => {
      if (!window.runGpuCoverageValidation) {
        throw new Error("Validation page did not register runGpuCoverageValidation");
      }
      return window.runGpuCoverageValidation();
    });
    console.table(results);
    const failed = results.filter((result) => !result.passed);
    if (failed.length > 0) {
      throw new Error(`${failed.length} GPU validation scenario(s) failed`);
    }
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
}

server.on("exit", (code) => {
  if (code && code !== 1) {
    console.error(stderr);
  }
});
