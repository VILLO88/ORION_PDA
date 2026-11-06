/**
 * Compila l'helper del Calendario (`src/main/calendario/helper.swift`) e lo
 * mette dove il main process lo cerca.
 *
 * ⚠️ E' un **eseguibile**, non un modulo nativo di Node: non ha nessuna ABI in
 * comune con Electron, quindi non va ricompilato quando Electron cambia
 * versione. Vedi CALENDARIO.md §5.
 *
 * ⚠️ Fuori da macOS non fallisce: stampa e basta. EventKit esiste solo li', e
 * un `npm run build` che si rompe su Windows per una funzione che su Windows
 * non c'e' sarebbe un bug del build, non una tutela.
 *
 *   node scripts/build-calendario.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { arch, platform } from "node:os";

const qui = dirname(fileURLToPath(import.meta.url));
const radice = resolve(qui, "..");

if (platform() !== "darwin") {
  console.log("calendario: si compila solo su macOS (EventKit). Saltato.");
  process.exit(0);
}

const sorgente = join(radice, "src", "main", "calendario", "helper.swift");
const chiave = `darwin-${arch() === "arm64" ? "arm64" : "x64"}`;
const cartella = join(radice, "src", "main", "resources", "calendario", chiave);
const uscita = join(cartella, "orion-calendario");

if (!existsSync(sorgente)) {
  console.error(`calendario: manca ${sorgente}`);
  process.exit(1);
}

mkdirSync(cartella, { recursive: true });

try {
  execFileSync("swiftc", ["-O", "-o", uscita, sorgente], { stdio: "inherit" });
} catch (e) {
  console.error(
    "calendario: swiftc non disponibile o compilazione fallita.\n" +
      "Serve Xcode o gli strumenti da riga di comando: xcode-select --install",
  );
  process.exit(1);
}

console.log(`calendario: ${uscita}`);
