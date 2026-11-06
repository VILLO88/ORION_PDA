/// <reference types="vite/client" />

import type { OrionAPI } from "@shared/ipc-types";

declare global {
  interface Window {
    orion: OrionAPI;
  }
  /** Iniettato a build time da electron.vite.config.ts (define),
   *  letto da package.json#version. */
  const __APP_VERSION__: string;
}

export {};
