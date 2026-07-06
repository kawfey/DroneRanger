import { chromium } from "playwright";
import { createServer } from "vite";

const port = Number(process.env.UI_TEST_PORT ?? 4177);
const host = "127.0.0.1";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function nearlyEqual(a, b, epsilon = 1e-7) {
  return Math.abs(a - b) <= epsilon;
}

function samePoint(a, b) {
  return nearlyEqual(a.lng, b.lng) && nearlyEqual(a.lat, b.lat);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function coordinatesChanged(before, after) {
  return JSON.stringify(before) !== JSON.stringify(after);
}

async function debugState(page) {
  return page.evaluate(() => {
    const debug = window.__droneRangeDebug;
    if (!debug) return null;
    return JSON.parse(JSON.stringify(debug));
  });
}

async function waitForDebug(page, predicate, message, timeout = 90000, arg = undefined) {
  const handle = await page.waitForFunction(predicate, arg, { timeout });
  const value = await handle.jsonValue();
  assert(value, message);
  return debugState(page);
}

async function dragMarker(page, dx, dy) {
  const marker = page.locator(".mapboxgl-marker").first();
  await marker.waitFor({ state: "visible", timeout: 30000 });
  const box = await marker.boundingBox();
  assert(box, "marker bounding box is available");
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx * 0.4, startY + dy * 0.4, { steps: 8 });
  await page.mouse.move(startX + dx, startY + dy, { steps: 12 });
  await page.mouse.up();
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

async function normalClickMap(page, xRatio, yRatio) {
  const box = await page.locator(".map").boundingBox();
  assert(box, "map bounding box is available");
  await page.mouse.click(box.x + box.width * xRatio, box.y + box.height * yRatio);
}

async function coveragePixels(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas[data-coverage-source=los-coverage]");
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error("coverage display canvas not found");
    }
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error("coverage display canvas context unavailable");
    }
    return {
      width: canvas.width,
      height: canvas.height,
      pixels: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data),
    };
  });
}

function averageRgbError(a, b, flipY = false) {
  assert(a.width === b.width && a.height === b.height, "coverage canvases should have matching dimensions");
  let error = 0;
  let count = 0;
  for (let y = 0; y < a.height; y++) {
    const by = flipY ? b.height - 1 - y : y;
    for (let x = 0; x < a.width; x++) {
      const ai = (y * a.width + x) * 4;
      const bi = (by * b.width + x) * 4;
      if (a.pixels[ai + 3] === 0 && b.pixels[bi + 3] === 0) {
        continue;
      }
      error +=
        Math.abs(a.pixels[ai] - b.pixels[bi]) +
        Math.abs(a.pixels[ai + 1] - b.pixels[bi + 1]) +
        Math.abs(a.pixels[ai + 2] - b.pixels[bi + 2]);
      count += 3;
    }
  }
  return count > 0 ? error / count : 0;
}

async function main() {
  const server = await createServer({
    server: {
      host,
      port,
      strictPort: true,
    },
  });
  let browser;

  try {
    await server.listen();
    const url = `http://${host}:${port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    page.setDefaultTimeout(45000);
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const initial = await waitForDebug(
      page,
      () => {
        const debug = window.__droneRangeDebug;
        return Boolean(
          debug?.hasCoverageSource &&
            debug.sourceType === "canvas" &&
            debug.coverageCoordinates &&
            debug.renderSequence > 0,
        );
      },
      "initial coverage source did not become canvas-backed",
    );

    assert(initial.engine === "cpu-fallback", "CPU fallback should be the default coverage engine");
    assert(initial.sourceTypeCounts.image === undefined, "initial style should not contain stale image sources");
    assert(initial.sourceTypeCounts.canvas === 1, "initial style should have exactly one canvas source");

    const initialOperator = clone(initial.latestOperator);
    const initialRenderedOperator = clone(initial.renderedOperator);
    const initialFingerprint = initial.coverageCanvasFingerprint;
    const initialCoverage = clone(initial.coverageCoordinates);
    const initialReferenceCircle = clone(initial.referenceCircle);
    const initialSequence = initial.renderSequence;

    await dragMarker(page, 130, 70);
    await waitForDebug(
      page,
      ([operator, sequence]) => {
        const debug = window.__droneRangeDebug;
        return Boolean(
          debug &&
            (Math.abs(debug.latestOperator.lng - operator.lng) > 1e-7 ||
              Math.abs(debug.latestOperator.lat - operator.lat) > 1e-7) &&
            debug.renderSequence > sequence,
        );
      },
      "dragend did not update operator, coverage, reference circle, and render sequence",
      undefined,
      [initialOperator, initialSequence],
    );
    const afterDrag = await waitForDebug(
      page,
      ([coverage, circle]) => {
        const debug = window.__droneRangeDebug;
        return Boolean(
          debug &&
            debug.renderedOperator &&
            Math.abs(debug.renderedOperator.lng - debug.latestOperator.lng) <= 1e-7 &&
            Math.abs(debug.renderedOperator.lat - debug.latestOperator.lat) <= 1e-7 &&
            JSON.stringify(debug.coverageCoordinates) !== JSON.stringify(coverage) &&
            JSON.stringify(debug.referenceCircle) !== JSON.stringify(circle),
        );
      },
      "dragend did not move coverage coordinates and reference circle",
      undefined,
      [initialCoverage, initialReferenceCircle],
    );

    assert(!samePoint(afterDrag.latestOperator, initialOperator), "dragend should move the operator");
    assert(!samePoint(afterDrag.markerLngLat, initialOperator), "marker should follow dragend");
    assert(samePoint(afterDrag.renderedOperator, afterDrag.latestOperator), "coverage render should use the dragged operator");
    assert(
      !samePoint(afterDrag.renderedOperator, initialRenderedOperator),
      "coverage render input should change after drag",
    );
    if (initialFingerprint && afterDrag.coverageCanvasFingerprint) {
      assert(
        afterDrag.coverageCanvasFingerprint !== initialFingerprint,
        "coverage canvas pixels should be recalculated after drag",
      );
    }
    assert(coordinatesChanged(initialCoverage, afterDrag.coverageCoordinates), "coverage coordinates should change after drag");
    assert(
      coordinatesChanged(initialReferenceCircle.geometry.coordinates, afterDrag.referenceCircle.geometry.coordinates),
      "reference circle GeoJSON should change after drag",
    );
    assert(afterDrag.sourceType === "canvas", "coverage source should remain canvas-backed after drag");
    assert(afterDrag.sourceTypeCounts.canvas === 1, "drag should keep one canvas source");
    assert(afterDrag.sourceTypeCounts.image === undefined, "drag should not create image sources");

    const beforeShift = clone(afterDrag);
    const beforeShiftFingerprint = beforeShift.coverageCanvasFingerprint;
    await shiftClickMap(page, 0.68, 0.44);
    await waitForDebug(
      page,
      ([operator, sequence]) => {
        const debug = window.__droneRangeDebug;
        return Boolean(
          debug &&
            (Math.abs(debug.latestOperator.lng - operator.lng) > 1e-7 ||
              Math.abs(debug.latestOperator.lat - operator.lat) > 1e-7) &&
            debug.renderSequence > sequence,
        );
      },
      "Shift-click did not update operator, coverage, reference circle, and render sequence",
      undefined,
      [beforeShift.latestOperator, beforeShift.renderSequence],
    );
    const afterShift = await waitForDebug(
      page,
      ([coverage, circle]) => {
        const debug = window.__droneRangeDebug;
        return Boolean(
          debug &&
            debug.renderedOperator &&
            Math.abs(debug.renderedOperator.lng - debug.latestOperator.lng) <= 1e-7 &&
            Math.abs(debug.renderedOperator.lat - debug.latestOperator.lat) <= 1e-7 &&
            JSON.stringify(debug.coverageCoordinates) !== JSON.stringify(coverage) &&
            JSON.stringify(debug.referenceCircle) !== JSON.stringify(circle),
        );
      },
      "Shift-click did not move coverage coordinates and reference circle",
      undefined,
      [beforeShift.coverageCoordinates, beforeShift.referenceCircle],
    );

    assert(!samePoint(afterShift.latestOperator, beforeShift.latestOperator), "Shift-click should move the operator");
    assert(samePoint(afterShift.markerLngLat, afterShift.latestOperator), "marker should match Shift-click operator");
    assert(samePoint(afterShift.renderedOperator, afterShift.latestOperator), "coverage render should use the Shift-click operator");
    assert(
      !samePoint(afterShift.renderedOperator, beforeShift.renderedOperator),
      "coverage render input should change after Shift-click",
    );
    if (beforeShiftFingerprint && afterShift.coverageCanvasFingerprint) {
      assert(
        afterShift.coverageCanvasFingerprint !== beforeShiftFingerprint,
        "coverage canvas pixels should be recalculated after Shift-click",
      );
    }
    assert(coordinatesChanged(beforeShift.coverageCoordinates, afterShift.coverageCoordinates), "coverage should move after Shift-click");
    assert(
      coordinatesChanged(beforeShift.referenceCircle.geometry.coordinates, afterShift.referenceCircle.geometry.coordinates),
      "reference circle should move after Shift-click",
    );

    const beforeNormal = clone(afterShift);
    await normalClickMap(page, 0.78, 0.52);
    await page.locator(".inspector").waitFor({ state: "visible", timeout: 30000 });
    const afterNormal = await debugState(page);

    assert(samePoint(afterNormal.latestOperator, beforeNormal.latestOperator), "normal click should not move operator");
    assert(samePoint(afterNormal.markerLngLat, beforeNormal.markerLngLat), "normal click should not move marker");
    assert(
      JSON.stringify(afterNormal.coverageCoordinates) === JSON.stringify(beforeNormal.coverageCoordinates),
      "normal click should not move coverage overlay",
    );
    assert(afterNormal.sourceType === "canvas", "coverage source should remain canvas-backed after normal click");

    await shiftClickMap(page, 0.58, 0.63);
    const afterSecondShift = await waitForDebug(
      page,
      ([operator, sequence]) => {
        const debug = window.__droneRangeDebug;
        return Boolean(
          debug &&
            (Math.abs(debug.latestOperator.lng - operator.lng) > 1e-7 ||
              Math.abs(debug.latestOperator.lat - operator.lat) > 1e-7) &&
            debug.renderSequence > sequence,
        );
      },
      "repeated operator move did not re-render coverage",
      undefined,
      [afterNormal.latestOperator, afterNormal.renderSequence],
    );

    assert(afterSecondShift.hasCoverageSource, "los-coverage source should exist after repeated moves");
    assert(afterSecondShift.sourceType === "canvas", "los-coverage source should be canvas-backed after repeated moves");
    assert(afterSecondShift.sourceTypeCounts.canvas === 1, "repeated moves should keep exactly one canvas source");
    assert(afterSecondShift.sourceTypeCounts.image === undefined, "repeated moves should not leave stale image sources");

    await page.getByTitle("Close inspector").click();
    await page.locator(".inspector").waitFor({ state: "hidden", timeout: 30000 });
    await page.getByText("Calculation settings").click();
    await page.getByRole("button", { name: "CPU" }).click();
    await waitForDebug(
      page,
      () => window.__droneRangeDebug?.preferredEngine === "cpu-fallback" && window.__droneRangeDebug?.engine === "cpu-fallback",
      "CPU renderer did not become active",
    );
    const cpuPixels = await coveragePixels(page);
    await page.getByRole("button", { name: "GPU" }).click();
    await waitForDebug(
      page,
      () => window.__droneRangeDebug?.preferredEngine === "gpu" && window.__droneRangeDebug?.engine === "gpu",
      "GPU renderer did not become active",
    );
    const gpuPixels = await coveragePixels(page);
    const directError = averageRgbError(cpuPixels, gpuPixels);
    const flippedError = averageRgbError(cpuPixels, gpuPixels, true);
    assert(
      directError <= flippedError,
      `GPU coverage appears vertically flipped: direct error ${directError.toFixed(2)}, flipped error ${flippedError.toFixed(2)}`,
    );
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
