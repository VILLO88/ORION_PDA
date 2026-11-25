import { app, BrowserWindow, ipcMain, protocol, shell } from "electron";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import { createReadStream, existsSync, statSync } from "node:fs";
import { release as osRelease } from "node:os";
import { extname, join } from "node:path";
import { Readable } from "node:stream";

// Scheme privilegiato per servire i file video locali al tag <video>.
// Necessario perché Chromium con webSecurity: true blocca i file:// dal renderer.
// Va dichiarato PRIMA di app.whenReady().
protocol.registerSchemesAsPrivileged([
  {
    scheme: "orion-media",
    privileges: {
      standard: true,
      stream: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
    },
  },
]);
import type {
  CalendarioFinestra,
  CalendarioScriviRequest,
  Mp3ConvertRequest,
  CoverSuggestRequest,
  CoverSearchRequest,
  NoteBackupAllRequest,
  NoteBackupRequest,
  NoteCopyRequest,
  NoteDeleteRequest,
  NoteListRequest,
  NoteMkdirRequest,
  NoteMoveRequest,
  NoteVaultImportRequest,
  NoteVaultRequest,
  NoteVaultUnlockRequest,
  NoteReadRequest,
  NoteRenameRequest,
  NoteTreeRequest,
  NotionSetParentRequest,
  NotionSyncRequest,
  ObsidianSyncRequest,
  PingRequest,
  PingResponse,
} from "../shared/ipc-types";
import {
  ejectDevice,
  listOrionDevices,
  startDeviceWatch,
  stopDeviceWatch,
} from "./ipc/device";
import {
  backupAllNotes,
  backupNote,
  getDefaults as getNoteDefaults,
  listNotes,
  notesCopy,
  notesDelete,
  notesMkdir,
  notesMove,
  notesRename,
  notesVaultExport,
  notesVaultImport,
  notesVaultLock,
  notesVaultStatus,
  notesVaultUnlock,
  readNote,
  treeNotes,
} from "./ipc/notes";
import { setVaultStoreDir, vaultLockAll } from "./notes/vault";
import { pickVault, syncObsidian } from "./ipc/obsidian";
import {
  connect as notionConnect,
  disconnect as notionDisconnect,
  status as notionStatus,
} from "./ipc/notion/auth";
import { searchPages as notionSearchPages } from "./ipc/notion/api";
import { patchConnection as notionPatchConnection } from "./ipc/notion/tokenStore";
import { syncNotion } from "./ipc/notion/sync";
import { convertAndUpload, probeFfmpeg } from "./ipc/mp3";
import { suggestCovers, searchItunesCovers } from "./ipc/cover";
import {
  chooseDirectory,
  expandAudioPaths,
  isDirectory,
} from "./ipc/fs";
import { convertEbook, previewEbook } from "./ipc/ebook";
import { wikiCancel, wikiConvert, wikiInfo, wikiSpazio } from "./ipc/wiki";
import * as storeAccount from "./store/account";
import * as store from "./store/store";
import {
  anteprimaCal,
  calInMemoria,
  calendariDisponibili,
  chiediPermesso as calendarioPermesso,
  scriviCalIn,
} from "./ipc/calendario";
import {
  bleMirrorDelete,
  bleMirrorMkdir,
  bleMirrorRead,
  bleMirrorSaveSnapshot,
  bleMirrorState,
  bleMirrorWrite,
  bleReadLocal,
  bleTmpDir,
} from "./ipc/bleLocal";
import type { BleSnapshot } from "../shared/ipc-types";
import { getDeviceStorage } from "./ipc/storage";
import {
  copyEntry,
  deleteFile,
  listFiles,
  makeDirectory,
  moveEntry,
  renameFile,
  uploadFile,
} from "./ipc/files";
import { cancelFlash, detectDfuDevice, flashFirmware } from "./firmware/dfu";
import { getDfuUtilPath } from "./firmware/paths";
import {
  ackIntegrityError,
  getUpdateState,
  initFirmwareUpdate,
  readSdVersion,
  refreshFirmwareUpdate,
  subscribeUpdateState,
  triggerDfu,
} from "./firmware/autoUpdate";
import {
  convertVideo,
  previewVideoFrame,
  probeFfmpegBin,
  probeVideoSource,
} from "./ipc/video";
import type {
  DeviceEjectRequest,
  DeviceStorageRequest,
  EbookConvertRequest,
  EbookPreviewRequest,
  WikiConvertRequest,
  StoreDecideRequest,
  StoreInstallRequest,
  StoreListRequest,
  StorePublishRequest,
  StoreReportRequest,
  StoreReviewRequest,
  StoreUninstallRequest,
  FilesCopyRequest,
  FilesDeleteRequest,
  FilesListRequest,
  FilesMkdirRequest,
  FilesMoveRequest,
  FilesRenameRequest,
  FilesUploadRequest,
  FirmwareDfuTriggerRequest,
  FirmwareFlashRequest,
  FirmwareSdVersionRequest,
  VideoConvertRequest,
  VideoPreviewRequest,
  VideoProbeRequest,
} from "../shared/ipc-types";

function mimeFromExt(ext: string): string {
  switch (ext) {
    case ".mp4": return "video/mp4";
    case ".m4v": return "video/mp4";
    case ".mov": return "video/quicktime";
    case ".webm": return "video/webm";
    case ".mkv": return "video/x-matroska";
    case ".avi": return "video/x-msvideo";
    default: return "application/octet-stream";
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#161f2c",
    title: "Orion Companion",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Abilita <webview> per la newsletter card (carica orionpda.org isolato).
      webviewTag: true,
    },
  });

  win.on("ready-to-show", () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  /* ⚠️ **Senza questo gancio Web Bluetooth non funziona, e non da' errore.**
     In un browser normale la scelta del dispositivo la fa il browser con la
     sua finestrella; in Electron non c'e' nessuna finestrella, e
     `navigator.bluetooth.requestDevice()` resta **appesa per sempre** finche'
     qualcuno non chiama questa callback. Il sintomo e' "premo connetti e non
     succede niente", che manda a cercare nel codice del Bluetooth.

     Qui si sceglie da soli: il primo dispositivo che pubblicizza il servizio
     0xFFF0 e' ORION, perche' e' il filtro che il renderer ha gia' applicato.
     ⚠️ `deviceList` arriva **piu' volte**, man mano che la scansione trova
     roba: chiamare `callback` due volte lancia un'eccezione, quindi si segna
     che si e' gia' risposto. */
  {
    let scelto = false;

    win.webContents.on("select-bluetooth-device", (event, deviceList, callback) => {
      event.preventDefault();
      if (scelto) return;

      const primo = deviceList[0];
      if (primo) {
        scelto = true;
        callback(primo.deviceId);
      }
      /* Se la lista e' vuota non si risponde: la scansione continua e la
         callback verra' richiamata appena qualcosa compare. */
    });

    win.webContents.on("did-finish-load", () => { scelto = false; });
  }

  /* Web Serial ha lo stesso gancio del Bluetooth qui sopra, e la stessa
     trappola: senza, `navigator.serial.requestPort()` non mostra niente e
     non torna. Serve a una cosa sola — farsi dare da ORION il deposito
     delle note protette (`lib/serialVault.ts`) — quindi si sceglie da soli
     la console di ORION dal suo VID/PID, che sono quelli di
     `usb_descriptors.c` nel firmware.
     ⚠️ Qui a lista vuota SI RISPONDE, con "": non c'e' una scansione che
     continua, e senza risposta la richiesta resterebbe appesa. */
  {
    const ORION_VID = 0xcafe;
    const ORION_PID = 0x4003;

    win.webContents.session.on("select-serial-port", (event, portList, _wc, callback) => {
      event.preventDefault();
      const orion = portList.find(
        (p) => Number(p.vendorId) === ORION_VID && Number(p.productId) === ORION_PID,
      );
      callback(orion ? orion.portId : "");
    });
  }

  // In dev mode electron-vite serves the renderer from a dev URL; in
  // production we load the bundled index.html shipped under out/renderer/.
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  /* Le copie dei depositi delle note protette: vedi notes/vault.ts. */
  setVaultStoreDir(join(app.getPath("userData"), "note-vaults"));

  electronApp.setAppUserModelId("com.orion.companion");

  app.on("browser-window-created", (_event, w) => {
    optimizer.watchWindowShortcuts(w);
  });

  // orion-media:///<abs-path> → streama il file locale con Range manuale.
  // Indispensabile per `<video currentTime=...>` di Chromium, che usa
  // Range requests per il seek su MP4 lunghi.
  protocol.handle("orion-media", (req) => {
    const url = new URL(req.url);
    const rawPath = decodeURIComponent(url.pathname);
    const absPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    if (!existsSync(absPath)) {
      return new Response("not found", { status: 404 });
    }
    const stats = statSync(absPath);
    const total = stats.size;
    const mime = mimeFromExt(extname(absPath).toLowerCase());

    const rangeHeader = req.headers.get("range");
    if (rangeHeader) {
      const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
      if (m) {
        const start = parseInt(m[1], 10);
        const end = m[2] ? parseInt(m[2], 10) : total - 1;
        const safeEnd = Math.min(end, total - 1);
        if (start >= total || start > safeEnd) {
          return new Response("range not satisfiable", {
            status: 416,
            headers: { "Content-Range": `bytes */${total}` },
          });
        }
        const nodeStream = createReadStream(absPath, { start, end: safeEnd });
        return new Response(
          Readable.toWeb(nodeStream) as unknown as ReadableStream,
          {
            status: 206,
            headers: {
              "Content-Type": mime,
              "Content-Length": String(safeEnd - start + 1),
              "Content-Range": `bytes ${start}-${safeEnd}/${total}`,
              "Accept-Ranges": "bytes",
            },
          },
        );
      }
    }

    const nodeStream = createReadStream(absPath);
    return new Response(
      Readable.toWeb(nodeStream) as unknown as ReadableStream,
      {
        status: 200,
        headers: {
          "Content-Type": mime,
          "Content-Length": String(total),
          "Accept-Ranges": "bytes",
        },
      },
    );
  });

  // ---- IPC handlers ------------------------------------------------------
  ipcMain.handle("ping", (_e, req: PingRequest): PingResponse => {
    return {
      echo: req.message,
      pid: process.pid,
      versions: {
        node: process.versions.node,
        chrome: process.versions.chrome,
        electron: process.versions.electron,
      },
    };
  });

  // System info per il Bug Report modal.
  ipcMain.handle("system:info", () => ({
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    osRelease: osRelease(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
  }));

  // Device discovery (Step 2)
  ipcMain.handle("device:list", () => listOrionDevices());
  ipcMain.handle("device:watch:start", () => {
    startDeviceWatch((devices) => {
      // Broadcast a tutti i renderer attivi.
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send("device:changed", devices);
      }
    });
  });
  ipcMain.handle("device:watch:stop", () => stopDeviceWatch());
  ipcMain.handle("device:eject", (_e, req: DeviceEjectRequest) =>
    ejectDevice(req),
  );

  // Storage breakdown del device (Home page)
  ipcMain.handle("storage:read", (_e, req: DeviceStorageRequest) =>
    getDeviceStorage(req),
  );

  // Files manager (Files tab)
  ipcMain.handle("files:list", (_e, req: FilesListRequest) => listFiles(req));
  ipcMain.handle("files:delete", (_e, req: FilesDeleteRequest) =>
    deleteFile(req),
  );
  ipcMain.handle("files:upload", (_e, req: FilesUploadRequest) =>
    uploadFile(req),
  );
  ipcMain.handle("files:mkdir", (_e, req: FilesMkdirRequest) =>
    makeDirectory(req),
  );
  ipcMain.handle("files:rename", (_e, req: FilesRenameRequest) =>
    renameFile(req),
  );
  ipcMain.handle("files:copy", (_e, req: FilesCopyRequest) => copyEntry(req));
  ipcMain.handle("files:move", (_e, req: FilesMoveRequest) => moveEntry(req));

  // Firmware DFU update
  ipcMain.handle("firmware:detect", async () => {
    const dfuUtilPath = await getDfuUtilPath();
    if (!dfuUtilPath) {
      return { device: null, dfuUtilAvailable: false, dfuUtilPath: null };
    }
    try {
      const device = await detectDfuDevice();
      return { device, dfuUtilAvailable: true, dfuUtilPath };
    } catch (err) {
      return {
        device: null,
        dfuUtilAvailable: false,
        dfuUtilPath,
        error: (err as Error).message,
      };
    }
  });
  ipcMain.handle("firmware:flash", async (e, req: FirmwareFlashRequest) => {
    const sender = e.sender;
    return flashFirmware(
      req.binPath,
      (ev) => {
        if (!sender.isDestroyed()) sender.send("firmware:progress", ev);
      },
      (line) => {
        if (!sender.isDestroyed()) sender.send("firmware:log", line);
      },
    );
  });
  ipcMain.handle("firmware:cancel", () => {
    cancelFlash();
  });

  // Firmware auto-update (manifest fetch + SD trigger)
  ipcMain.handle("firmware:update:getState", () => getUpdateState());
  ipcMain.handle("firmware:update:refresh", () => refreshFirmwareUpdate());
  ipcMain.handle(
    "firmware:update:readSdVersion",
    (_e, req: FirmwareSdVersionRequest) => readSdVersion(req),
  );
  ipcMain.handle(
    "firmware:update:triggerDfu",
    (_e, req: FirmwareDfuTriggerRequest) => triggerDfu(req),
  );
  ipcMain.handle("firmware:update:ackIntegrityError", () =>
    ackIntegrityError(),
  );
  ipcMain.handle("firmware:update:flashCached", async (e) => {
    const s = getUpdateState();
    if (!s.binCached || !s.binPath) {
      return {
        ok: false,
        message:
          "No firmware cached. Wait for the download to finish or refresh.",
      };
    }
    const sender = e.sender;
    return flashFirmware(
      s.binPath,
      (ev) => {
        if (!sender.isDestroyed()) sender.send("firmware:progress", ev);
      },
      (line) => {
        if (!sender.isDestroyed()) sender.send("firmware:log", line);
      },
    );
  });

  // Broadcast state changes to all renderers.
  subscribeUpdateState((s) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("firmware:update:state", s);
    }
  });
  // Kick off background download.
  void initFirmwareUpdate();

  // Notes (Step 3) — backup PC ← device + folder management
  ipcMain.handle("notes:list", (_e, req: NoteListRequest) => listNotes(req));
  ipcMain.handle("notes:tree", (_e, req: NoteTreeRequest) => treeNotes(req));
  ipcMain.handle("notes:read", (_e, req: NoteReadRequest) => readNote(req));
  ipcMain.handle("notes:backup", (_e, req: NoteBackupRequest) => backupNote(req));
  ipcMain.handle("notes:backupAll", (_e, req: NoteBackupAllRequest) =>
    backupAllNotes(req),
  );
  ipcMain.handle("notes:defaults", () => getNoteDefaults());
  ipcMain.handle("notes:reveal", (_e, p: string) => {
    shell.showItemInFolder(p);
  });
  ipcMain.handle("notes:mkdir", (_e, req: NoteMkdirRequest) => notesMkdir(req));
  ipcMain.handle("notes:rename", (_e, req: NoteRenameRequest) => notesRename(req));
  ipcMain.handle("notes:delete", (_e, req: NoteDeleteRequest) => notesDelete(req));
  ipcMain.handle("notes:copy", (_e, req: NoteCopyRequest) => notesCopy(req));
  ipcMain.handle("notes:move", (_e, req: NoteMoveRequest) => notesMove(req));
  ipcMain.handle("notes:vaultStatus", (_e, req: NoteVaultRequest) => notesVaultStatus(req));
  ipcMain.handle("notes:vaultUnlock", (_e, req: NoteVaultUnlockRequest) => notesVaultUnlock(req));
  ipcMain.handle("notes:vaultLock", (_e, req: NoteVaultRequest) => notesVaultLock(req));
  ipcMain.handle("notes:vaultExport", (_e, req: NoteVaultUnlockRequest) => notesVaultExport(req));
  ipcMain.handle("notes:vaultImport", (_e, req: NoteVaultImportRequest) => notesVaultImport(req));

  // Obsidian sync — bidirezionale <mount>/NOTE/ <-> vault Obsidian
  ipcMain.handle("obsidian:pickVault", () => pickVault());
  ipcMain.handle("obsidian:sync", (_e, req: ObsidianSyncRequest) =>
    syncObsidian(req),
  );

  // Notion sync — OAuth (broker) + bidirezionale <mount>/NOTE/ <-> Notion
  ipcMain.handle("notion:connect", () => notionConnect());
  ipcMain.handle("notion:status", () => notionStatus());
  ipcMain.handle("notion:disconnect", () => notionDisconnect());
  ipcMain.handle("notion:listPages", async () => ({
    pages: await notionSearchPages(),
  }));
  ipcMain.handle("notion:setParent", async (_e, req: NotionSetParentRequest) => {
    await notionPatchConnection({
      parentPageId: req.pageId,
      parentPageTitle: req.title,
    });
  });
  ipcMain.handle("notion:sync", (_e, req: NotionSyncRequest) => syncNotion(req));

  // FS helpers (Step 4+)
  ipcMain.handle("fs:expandAudioPaths", (_e, paths: string[]) =>
    expandAudioPaths(paths),
  );
  ipcMain.handle("fs:chooseDirectory", () => chooseDirectory());
  ipcMain.handle("fs:isDirectory", (_e, p: string) => isDirectory(p));

  // MP3 manager (Step 4)
  ipcMain.handle("mp3:probe", () => probeFfmpeg());
  ipcMain.handle("mp3:convert", async (e, req: Mp3ConvertRequest) => {
    const sender = e.sender;
    return convertAndUpload(req, (ev) => {
      if (!sender.isDestroyed()) sender.send("mp3:progress", ev);
    });
  });

  // Album cover online (iTunes Search API)
  ipcMain.handle("cover:suggest", (_e, req: CoverSuggestRequest) =>
    suggestCovers(req),
  );
  ipcMain.handle("cover:search", async (_e, req: CoverSearchRequest) => ({
    results: await searchItunesCovers(req.term),
  }));

  // Ebook converter (Step 5+6+9 → ora supporta .md/.txt/.epub/.pdf)
  ipcMain.handle("ebook:convert", async (e, req: EbookConvertRequest) => {
    const sender = e.sender;
    return convertEbook(req, (ev) => {
      if (!sender.isDestroyed()) sender.send("ebook:progress", ev);
    });
  });
  ipcMain.handle("ebook:preview", (_e, req: EbookPreviewRequest) =>
    previewEbook(req),
  );

  // App Store: Lua apps from everyone, moderated. See src/main/store and store/.
  ipcMain.handle("store:account", () => storeAccount.account());
  ipcMain.handle("store:signIn", () => storeAccount.signIn());
  ipcMain.handle("store:signOut", () => storeAccount.signOut());
  ipcMain.handle("store:list", (_e, req: StoreListRequest) => store.list(req));
  ipcMain.handle("store:detail", (_e, slug: string) => store.detail(slug));
  ipcMain.handle("store:reviews", (_e, slug: string) => store.reviews(slug));
  ipcMain.handle("store:review", (_e, req: StoreReviewRequest) => store.review(req));
  ipcMain.handle("store:deleteReview", (_e, slug: string) => store.deleteReview(slug));
  ipcMain.handle("store:report", (_e, req: StoreReportRequest) => store.report(req));
  ipcMain.handle("store:installed", (_e, mountPath: string) => store.installed(mountPath));
  ipcMain.handle("store:install", (_e, req: StoreInstallRequest) => store.install(req));
  ipcMain.handle("store:uninstall", (_e, req: StoreUninstallRequest) => store.uninstall(req));
  ipcMain.handle("store:pickSource", () => store.pickSource());
  ipcMain.handle("store:readSource", (_e, p: string) => store.readSource(p));
  ipcMain.handle("store:publish", (_e, req: StorePublishRequest) => store.publish(req));
  ipcMain.handle("store:pickScreenshots", () => store.pickScreenshots());
  ipcMain.handle("store:screenshot", (_e, slug: string, version: string, i: number) => store.screenshot(slug, version, i));
  ipcMain.handle("store:tryFiles", (_e, slug: string, version?: string) => store.tryFiles(slug, version));
  ipcMain.handle("store:packageFiles", (_e, slug: string, version?: string) => store.packageFiles(slug, version));
  ipcMain.handle("store:localFiles", (_e, p: string, ex?: string[]) => store.localFiles(p, ex));
  ipcMain.handle("store:saveCapture", (_e, d: string) => store.saveCapture(d));
  ipcMain.handle("store:myApps", () => store.myApps());
  ipcMain.handle("store:withdraw", (_e, id: number) => store.withdraw(id));
  ipcMain.handle("store:queue", () => store.queue());
  ipcMain.handle("store:decide", (_e, req: StoreDecideRequest) => store.decide(req));
  ipcMain.handle("store:setHidden", (_e, slug: string, hidden: boolean) => store.setHidden(slug, hidden));
  ipcMain.handle("store:hideReview", (_e, id: number) => store.hideReview(id));
  ipcMain.handle("store:reports", () => store.reports());
  ipcMain.handle("store:resolveReport", (_e, id: number) => store.resolveReport(id));
  ipcMain.handle("store:ban", (_e, login: string, banned: boolean) => store.ban(login, banned));

  // Wikipedia: a Kiwix ZIM -> the ORION Wiki format. See src/main/wiki.
  ipcMain.handle("wiki:info", (_e, zimPath: string) => wikiInfo(zimPath));
  ipcMain.handle("wiki:space", (_e, dir: string) => wikiSpazio(dir));
  ipcMain.handle("wiki:convert", async (e, req: WikiConvertRequest) => {
    const sender = e.sender;
    return wikiConvert(req, (ev) => {
      if (!sender.isDestroyed()) sender.send("wiki:progress", ev);
    });
  });
  ipcMain.handle("wiki:cancel", () => wikiCancel());

  // Calendario: Mac -> .cal -> microSD. Vedi PDAV3/CALENDARIO.md.
  /* Il lato disco del Bluetooth: lo specchio delle note, e i byte dei file
     del PC che la finestra manda via radio. Vedi `ipc/bleLocal.ts`. */
  ipcMain.handle("ble:mirrorState", () => bleMirrorState());
  ipcMain.handle("ble:mirrorWrite", (_e, req: { rel: string; dati: Uint8Array }) =>
    bleMirrorWrite(req),
  );
  ipcMain.handle("ble:mirrorRead", (_e, req: { rel: string }) => bleMirrorRead(req));
  ipcMain.handle("ble:mirrorDelete", (_e, req: { rel: string }) => bleMirrorDelete(req));
  ipcMain.handle("ble:mirrorMkdir", (_e, req: { rel: string }) => bleMirrorMkdir(req));
  ipcMain.handle("ble:mirrorSaveSnapshot", (_e, s: BleSnapshot) => bleMirrorSaveSnapshot(s));
  ipcMain.handle("ble:readLocal", (_e, req: { path: string }) => bleReadLocal(req));
  ipcMain.handle("ble:tmpDir", () => bleTmpDir());

  ipcMain.handle("calendario:permesso", () => calendarioPermesso());
  ipcMain.handle("calendario:elenco", () => calendariDisponibili());
  ipcMain.handle("calendario:anteprima", (_e, req: CalendarioFinestra) =>
    anteprimaCal(req),
  );
  ipcMain.handle("calendario:scrivi", (_e, req: CalendarioScriviRequest) =>
    scriviCalIn(req.mountPath, req),
  );
  /* ⚠️ I byte tornano al renderer perche' e' li' che vive Web Bluetooth: il
     `.cal` lo costruisce il main, ma a mandarlo via radio e' la finestra. */
  ipcMain.handle("calendario:dati", (_e, req: CalendarioFinestra) =>
    calInMemoria(req),
  );

  // Video pipeline (Step 10)
  ipcMain.handle("video:probe", () => probeFfmpegBin());
  ipcMain.handle("video:convert", async (e, req: VideoConvertRequest) => {
    const sender = e.sender;
    return convertVideo(req, (ev) => {
      if (!sender.isDestroyed()) sender.send("video:progress", ev);
    });
  });
  ipcMain.handle("video:probeSource", (_e, req: VideoProbeRequest) =>
    probeVideoSource(req),
  );
  ipcMain.handle("video:preview", (_e, req: VideoPreviewRequest) =>
    previewVideoFrame(req),
  );

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/* Le chiavi delle note protette non sopravvivono all'app. */
app.on("before-quit", () => vaultLockAll());

app.on("window-all-closed", () => {
  stopDeviceWatch();
  if (process.platform !== "darwin") app.quit();
});
