import { app, BrowserWindow, ipcMain, shell } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFile } from "node:child_process";

const appName = "Drone Ranger";
const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173";
const mapboxTokenFileName = "mapbox-token.json";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function configureUserDataPath() {
  const userDataPath = path.join(app.getPath("home"), ".drone_ranger");

  mkdirSync(userDataPath, { recursive: true });
  app.setPath("userData", userDataPath);

  if (process.platform === "win32") {
    execFile("attrib", ["+H", userDataPath], () => {
      // Best-effort only. Startup should not depend on Windows shell attributes.
    });
  }

  return userDataPath;
}

const userDataPath = configureUserDataPath();
const mapboxTokenPath = path.join(userDataPath, mapboxTokenFileName);

function isDevelopment() {
  return !app.isPackaged;
}

function shouldOpenExternally(url: string) {
  return url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:");
}

function readStoredMapboxToken(): string {
  try {
    const stored = JSON.parse(readFileSync(mapboxTokenPath, "utf8")) as { token?: unknown };
    return typeof stored.token === "string" ? stored.token.trim() : "";
  } catch {
    return "";
  }
}

function storeMapboxToken(token: string): void {
  writeFileSync(mapboxTokenPath, JSON.stringify({ token: token.trim() }, null, 2), { mode: 0o600 });
}

function mapboxTokenPromptHtml(errorMessage = ""): string {
  const escapedError = errorMessage
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Mapbox API key</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #172033;
        background: #f4f7fb;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
      }

      form {
        width: min(430px, calc(100vw - 48px));
        display: grid;
        gap: 14px;
      }

      h1 {
        margin: 0;
        font-size: 22px;
        font-weight: 720;
      }

      p {
        margin: 0;
        color: #526174;
        line-height: 1.45;
      }

      label {
        display: grid;
        gap: 7px;
        font-size: 13px;
        font-weight: 650;
        color: #344258;
      }

      input {
        min-height: 42px;
        border: 1px solid #b7c3d4;
        border-radius: 6px;
        padding: 0 12px;
        font: inherit;
        color: #172033;
        background: #ffffff;
      }

      input:focus {
        border-color: #1f8fff;
        box-shadow: 0 0 0 3px rgba(31, 143, 255, 0.18);
        outline: none;
      }

      button {
        min-height: 42px;
        border: 0;
        border-radius: 6px;
        padding: 0 16px;
        font: inherit;
        font-weight: 700;
        color: #ffffff;
        background: #1967d2;
        cursor: pointer;
      }

      .error {
        min-height: 20px;
        color: #b3261e;
        font-size: 13px;
      }
    </style>
  </head>
  <body>
    <form>
      <h1>Mapbox API key</h1>
      <p>Drone Ranger needs a Mapbox API key to load maps, terrain, and building data. The key will be stored on this device.</p>
      <label>
        API key
        <input name="token" type="password" autocomplete="off" spellcheck="false" autofocus />
      </label>
      <button type="submit">Save key</button>
      <div class="error" role="alert">${escapedError}</div>
    </form>
    <script>
      const form = document.querySelector("form");
      const input = document.querySelector("input");
      const error = document.querySelector(".error");

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const token = input.value.trim();
        if (!token) {
          error.textContent = "Enter a Mapbox API key.";
          input.focus();
          return;
        }

        const result = await window.droneRangerTokenPrompt.save(token);
        if (!result.ok) {
          error.textContent = result.error || "The key could not be saved.";
          input.focus();
        }
      });
    </script>
  </body>
</html>`;
}

async function promptForMapboxToken(): Promise<string> {
  let token = readStoredMapboxToken();
  if (token) {
    return token;
  }

  let promptWindow: BrowserWindow | null = null;
  ipcMain.handle("mapbox-token:save", (_event, nextToken: unknown) => {
    if (typeof nextToken !== "string" || !nextToken.trim()) {
      return { ok: false, error: "Enter a Mapbox API key." };
    }

    try {
      token = nextToken.trim();
      storeMapboxToken(token);
      promptWindow?.close();
      return { ok: true };
    } catch {
      return { ok: false, error: "The key could not be saved. Check app storage permissions." };
    }
  });

  try {
    await new Promise<void>((resolve) => {
      promptWindow = new BrowserWindow({
        width: 520,
        height: 390,
        resizable: false,
        maximizable: false,
        minimizable: false,
        title: "Mapbox API key",
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });

      promptWindow.setMenuBarVisibility(false);
      promptWindow.on("closed", resolve);
      void promptWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(mapboxTokenPromptHtml())}`);
    });
  } finally {
    ipcMain.removeHandler("mapbox-token:save");
  }

  return token;
}

async function createWindow() {
  const isDev = isDevelopment();
  const mapboxToken = isDev ? "" : await promptForMapboxToken();
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: !isDev,
    title: appName,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
        `--drone-ranger-user-data=${userDataPath}`,
        `--drone-ranger-mapbox-token=${mapboxToken}`,
      ],
    },
  });

  if (!isDev) {
    mainWindow.setMenu(null);
    mainWindow.setMenuBarVisibility(false);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenExternally(url)) {
      void shell.openExternal(url);
    }

    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const currentUrl = mainWindow.webContents.getURL();
    if (url === currentUrl) {
      return;
    }

    event.preventDefault();
    if (shouldOpenExternally(url)) {
      void shell.openExternal(url);
    }
  });

  if (isDev) {
    await mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  await mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
}

app.setName(appName);

void app.whenReady().then(async () => {
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
