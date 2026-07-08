import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  if (command === "build" && env.VITE_MAPBOX_TOKEN?.trim()) {
    throw new Error("Refusing production build with VITE_MAPBOX_TOKEN set. Packaged apps must use the Electron token prompt.");
  }

  return {
    base: "./",
    plugins: [react()],
  };
});
