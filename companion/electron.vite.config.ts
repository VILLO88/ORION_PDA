import { resolve } from "path";
import { readFileSync } from "fs";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
  version: string;
};
const APP_VERSION = JSON.stringify(pkg.version);

export default defineConfig({
  main: {
    /* any-ascii and entities are ES modules only, and Electron 30 (Node 20)
       cannot require() one: they go into the bundle instead (Wikipedia
       converter, src/main/wiki). */
    plugins: [externalizeDepsPlugin({ exclude: ["any-ascii", "entities"] })],
    build: {
      rollupOptions: {
        input: { index: resolve("src/main/index.ts") },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve("src/preload/index.ts") },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react()],
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
        "@shared": resolve("src/shared"),
      },
    },
    define: {
      __APP_VERSION__: APP_VERSION,
    },
    build: {
      rollupOptions: {
        input: { index: resolve("src/renderer/index.html") },
      },
    },
  },
});
