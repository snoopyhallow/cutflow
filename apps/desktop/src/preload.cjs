"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const bootstrap = ipcRenderer.sendSync("cutflow:get-bootstrap") || {};

contextBridge.exposeInMainWorld("cutflowDesktop", {
  isDesktop: true,
  desktopToken: bootstrap.desktopToken || "",
  platform: bootstrap.platform || process.platform,
  appVersion: bootstrap.appVersion || "1.0.0",
  openMediaDialog: (opts) => ipcRenderer.invoke("cutflow:open-media-dialog", opts),
  minimizeWindow: () => ipcRenderer.send("cutflow:window-minimize"),
  toggleMaximizeWindow: () => ipcRenderer.send("cutflow:window-toggle-maximize"),
  closeWindow: () => ipcRenderer.send("cutflow:window-close"),
});
