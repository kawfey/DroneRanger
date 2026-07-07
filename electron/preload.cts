import { contextBridge } from "electron";

const userDataPrefix = "--drone-ranger-user-data=";
const userDataPath =
  process.argv.find((argument) => argument.startsWith(userDataPrefix))?.slice(userDataPrefix.length) ?? "";

contextBridge.exposeInMainWorld(
  "droneRanger",
  Object.freeze({
    platform: process.platform,
    userDataPath,
  }),
);
