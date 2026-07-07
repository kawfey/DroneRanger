import { contextBridge, ipcRenderer } from "electron";

const userDataPrefix = "--drone-ranger-user-data=";
const userDataPath =
  process.argv.find((argument) => argument.startsWith(userDataPrefix))?.slice(userDataPrefix.length) ?? "";
const mapboxTokenPrefix = "--drone-ranger-mapbox-token=";
const mapboxToken =
  process.argv.find((argument) => argument.startsWith(mapboxTokenPrefix))?.slice(mapboxTokenPrefix.length) ?? "";

contextBridge.exposeInMainWorld(
  "droneRanger",
  Object.freeze({
    platform: process.platform,
    userDataPath,
    mapboxToken,
  }),
);

contextBridge.exposeInMainWorld(
  "droneRangerTokenPrompt",
  Object.freeze({
    save: (token: string) => ipcRenderer.invoke("mapbox-token:save", token),
  }),
);
