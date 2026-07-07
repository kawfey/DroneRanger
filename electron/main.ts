import { app, BrowserWindow, shell } from "electron";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFile } from "node:child_process";

const appName = "Drone Ranger";
const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173";

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

function isDevelopment() {
  return !app.isPackaged;
}

function shouldOpenExternally(url: string) {
  return url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:");
}

async function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: appName,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--drone-ranger-user-data=${userDataPath}`],
    },
  });

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

  if (isDevelopment()) {
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
