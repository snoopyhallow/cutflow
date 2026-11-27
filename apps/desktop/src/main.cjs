"use strict";

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const IS_SMOKE_TEST = process.argv.includes("--smoke-test");
const DESKTOP_TOKEN = crypto.randomBytes(32).toString("hex");

let mainWindow = null;
let backendProc = null;
let backendPort = 0;
let quitting = false;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 8018;
      srv.close(() => resolve(port));
    });
  });
}

function candidateRoots() {
  const roots = new Set();
  const seeds = [
    app.getAppPath(),
    path.dirname(process.execPath),
    process.resourcesPath || "",
    process.cwd(),
    __dirname,
  ].filter(Boolean);

  for (const seed of seeds) {
    let cur = path.resolve(seed);
    for (let i = 0; i < 7; i += 1) {
      roots.add(cur);
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return Array.from(roots);
}

function resolveWebDistDir() {
  if (process.env.CUTFLOW_WEB_DIST && fs.existsSync(path.join(process.env.CUTFLOW_WEB_DIST, "index.html"))) {
    return path.resolve(process.env.CUTFLOW_WEB_DIST);
  }
  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, "web-dist");
    if (fs.existsSync(path.join(bundled, "index.html"))) {
      return bundled;
    }
  }
  for (const root of candidateRoots()) {
    const candidate = path.join(root, "apps", "web", "dist");
    if (fs.existsSync(path.join(candidate, "index.html"))) {
      return candidate;
    }
  }
  return "";
}

function resolvePythonBackend() {
  if (process.env.CUTFLOW_PYTHON_EXE && fs.existsSync(process.env.CUTFLOW_PYTHON_EXE)) {
    return {
      pythonExe: process.env.CUTFLOW_PYTHON_EXE,
      cwd: process.cwd(),
    };
  }
  for (const root of candidateRoots()) {
    const winVenv = path.join(root, "apps", "api", ".venv", "Scripts", "python.exe");
    if (fs.existsSync(winVenv)) {
      return {
        pythonExe: winVenv,
        cwd: path.join(root, "apps", "api"),
      };
    }
    const posixVenv = path.join(root, "apps", "api", ".venv", "bin", "python");
    if (fs.existsSync(posixVenv)) {
      return {
        pythonExe: posixVenv,
        cwd: path.join(root, "apps", "api"),
      };
    }
  }
  return {
    pythonExe: process.platform === "win32" ? "python.exe" : "python3",
    cwd: process.cwd(),
  };
}

function checkHealthOnce(port) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/v1/health",
        timeout: 1200,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForBackendReady(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkHealthOnce(port)) return true;
    await new Promise((r) => setTimeout(r, 160));
  }
  return false;
}

function stopBackendProcess() {
  if (!backendProc || backendProc.killed) return;
  const pid = backendProc.pid;
  try {
    if (process.platform === "win32" && pid) {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      backendProc.kill("SIGTERM");
    }
  } catch {
    /* ignore cleanup error */
  }
  backendProc = null;
}

function buildLoadingDataUrl(message) {
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  body {
    margin: 0; height: 100vh; display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    background: #09090B; color: #F4F4F5;
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    user-select: none;
  }
  .ring {
    width: 34px; height: 34px; border-radius: 9999px;
    border: 3px solid #27272A; border-top-color: #F59E0B;
    animation: spin 0.8s linear infinite;
  }
  h1 { font-size: 15px; margin: 16px 0 4px; font-weight: 700; letter-spacing: -0.01em; }
  p { font-size: 12px; margin: 0; color: #A1A1AA; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="ring"></div>
  <h1>CutFlow Studio</h1>
  <p>${message}</p>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function registerIpcHandlers() {
  ipcMain.on("cutflow:get-bootstrap", (event) => {
    event.returnValue = {
      desktopToken: DESKTOP_TOKEN,
      platform: process.platform,
      appVersion: app.getVersion(),
    };
  });

  ipcMain.handle("cutflow:open-media-dialog", async (_event, opts = {}) => {
    if (!mainWindow) return [];
    const properties = ["openFile"];
    if (opts.multiple) properties.push("multiSelections");
    const filters = opts.filters || [
      {
        name: "Video & Audio Media",
        extensions: ["mp4", "mkv", "mov", "webm", "avi", "m4v", "mp3", "wav", "m4a", "flac", "ogg"],
      },
      { name: "All Files", extensions: ["*"] },
    ];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Import Local Media into CutFlow Studio",
      properties,
      filters,
    });
    if (result.canceled) return [];
    return result.filePaths || [];
  });

  ipcMain.on("cutflow:window-minimize", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });

  ipcMain.on("cutflow:window-toggle-maximize", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });

  ipcMain.on("cutflow:window-close", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });
}

async function createStudioWindow() {
  backendPort = await findFreePort();
  const webDist = resolveWebDistDir();
  const { pythonExe, cwd } = resolvePythonBackend();

  const env = {
    ...process.env,
    PYTHONUTF8: "1",
    CUTFLOW_DESKTOP_TOKEN: DESKTOP_TOKEN,
    ...(webDist ? { CUTFLOW_WEB_DIST: webDist } : {}),
  };

  let stderrTail = "";
  backendProc = spawn(
    pythonExe,
    [
      "-m",
      "uvicorn",
      "cutflow.app:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(backendPort),
      "--log-level",
      "warning",
    ],
    {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  backendProc.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-1800);
  });

  mainWindow = new BrowserWindow({
    width: 1520,
    height: 920,
    minWidth: 1100,
    minHeight: 680,
    frame: false,
    show: !IS_SMOKE_TEST,
    backgroundColor: "#09090B",
    title: "CutFlow Studio",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  await mainWindow.loadURL(
    buildLoadingDataUrl("Starting local FFmpeg, Whisper & Timeline Engine..."),
  );

  const ready = await waitForBackendReady(backendPort, 25000);
  if (!ready) {
    const errMsg = `Local engine did not start on 127.0.0.1:${backendPort}. ${stderrTail.slice(-240)}`;
    if (IS_SMOKE_TEST) {
      console.error("CUTFLOW_DESKTOP_SMOKE_FAIL:", errMsg);
      stopBackendProcess();
      app.exit(1);
      return;
    }
    await mainWindow.loadURL(buildLoadingDataUrl(errMsg));
    return;
  }

  const studioUrl = `http://127.0.0.1:${backendPort}/`;
  await mainWindow.loadURL(studioUrl);

  if (IS_SMOKE_TEST) {
    try {
      const check = await mainWindow.webContents.executeJavaScript(
        `({
          isDesktop: Boolean(window.cutflowDesktop && window.cutflowDesktop.isDesktop),
          hasToken: Boolean(window.cutflowDesktop && window.cutflowDesktop.desktopToken),
          title: document.title
        })`,
      );
      if (check && check.isDesktop && check.hasToken) {
        console.log(
          `CUTFLOW_DESKTOP_SMOKE_OK port=${backendPort} title="${check.title}"`,
        );
        stopBackendProcess();
        app.exit(0);
        return;
      }
      console.error("CUTFLOW_DESKTOP_SMOKE_FAIL: bridge check failed", check);
      stopBackendProcess();
      app.exit(1);
    } catch (err) {
      console.error("CUTFLOW_DESKTOP_SMOKE_FAIL:", err);
      stopBackendProcess();
      app.exit(1);
    }
  }
}

app.on("window-all-closed", () => {
  quitting = true;
  stopBackendProcess();
  app.quit();
});

app.on("before-quit", () => {
  if (!quitting) {
    quitting = true;
    stopBackendProcess();
  }
});

process.on("exit", () => {
  stopBackendProcess();
});

app.whenReady().then(async () => {
  registerIpcHandlers();
  await createStudioWindow();
});
