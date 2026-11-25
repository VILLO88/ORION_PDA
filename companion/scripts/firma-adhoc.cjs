/**
 * electron-builder afterPack: firma "ad hoc" l'intera app su macOS.
 *
 * Senza un Developer ID Apple il build non e' firmato (`identity: null`), ma
 * cosi' resta la firma parziale che il linker mette sul binario di Electron:
 * il bundle risulta "non sigillato" e, scaricato da internet (quarantena),
 * macOS lo dichiara **danneggiato** — un messaggio che non si scavalca col
 * tasto destro. Firmato ad hoc per intero diventa invece "sviluppatore non
 * identificato", che si apre da Impostazioni > Privacy e sicurezza > Apri
 * comunque. Visto con la 0.13.0 (25/11/2026): il .dmg locale partiva solo
 * perche' non era stato scaricato.
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function firmaAdHoc(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • firma ad hoc  ${app}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
};
