/**
 * Wrapper attorno a window.orion (esposto dal preload).
 *
 * I componenti importano `api.*` invece di `window.orion.*` direttamente.
 * Resilient: se aperto in browser puro (no preload), tutte le chiamate
 * rifiutano con un errore esplicativo invece di crashare al module load.
 */

import type {
  DeviceChangedListener,
  DeviceListResponse,
  NoteDefaultsResponse,
  OrionAPI,
  PingRequest,
} from "@shared/ipc-types";

export const isElectron = typeof window !== "undefined" && !!window.orion;

const notInElectron = (channel: string) =>
  Promise.reject(
    new Error(
      `IPC channel "${channel}" non disponibile: apri l'app con "npm run dev" (finestra Electron), non in browser.`,
    ),
  );

const stubOrion: OrionAPI = {
  ping: () => notInElectron("ping") as never,
  ble: {
    mirrorState: () => notInElectron("ble:mirrorState") as never,
    mirrorWrite: () => notInElectron("ble:mirrorWrite") as never,
    mirrorRead: () => notInElectron("ble:mirrorRead") as never,
    mirrorDelete: () => notInElectron("ble:mirrorDelete") as never,
    mirrorMkdir: () => notInElectron("ble:mirrorMkdir") as never,
    mirrorSaveSnapshot: () => notInElectron("ble:mirrorSaveSnapshot") as never,
    readLocal: () => notInElectron("ble:readLocal") as never,
    tmpDir: () => notInElectron("ble:tmpDir") as never,
  },
  calendario: {
    permesso: () => notInElectron("calendario:permesso") as never,
    elenco: () => notInElectron("calendario:elenco") as never,
    anteprima: () => notInElectron("calendario:anteprima") as never,
    scrivi: () => notInElectron("calendario:scrivi") as never,
    dati: () => notInElectron("calendario:dati") as never,
  },
  system: {
    info: () =>
      Promise.resolve({
        appVersion: "dev",
        platform: typeof navigator !== "undefined" ? navigator.platform : "unknown",
        arch: "unknown",
        osRelease: "unknown",
        electronVersion: "n/a",
        nodeVersion: "n/a",
        chromeVersion: "n/a",
      }),
  },
  device: {
    list: () => Promise.resolve<DeviceListResponse>({ devices: [] }),
    startWatch: () => Promise.resolve(),
    stopWatch: () => Promise.resolve(),
    onChanged: (_cb: DeviceChangedListener) => () => {},
    eject: () => notInElectron("device.eject") as never,
  },
  storage: {
    read: () => notInElectron("storage.read") as never,
  },
  notes: {
    list: () => Promise.resolve({ notes: [] }),
    tree: () =>
      Promise.resolve({
        root: {
          kind: "folder",
          name: "",
          path: "",
          relPath: "",
          children: [],
        },
      }),
    read: () => notInElectron("notes.read") as never,
    backup: () => notInElectron("notes.backup") as never,
    backupAll: () => Promise.resolve({ written: [], errors: [] }),
    defaults: () =>
      Promise.resolve<NoteDefaultsResponse>({ defaultBackupDir: "" }),
    revealBackupDir: () => Promise.resolve(),
    mkdir: () => notInElectron("notes.mkdir") as never,
    rename: () => notInElectron("notes.rename") as never,
    del: () => notInElectron("notes.del") as never,
    copy: () => notInElectron("notes.copy") as never,
    move: () => notInElectron("notes.move") as never,
    vaultStatus: () => Promise.resolve({ exists: false, unlocked: false, needsKey: false }),
    vaultUnlock: () => notInElectron("notes.vaultUnlock") as never,
    vaultLock: () => Promise.resolve({ exists: false, unlocked: false, needsKey: false }),
    vaultImport: () => notInElectron("notes.vaultImport") as never,
    vaultExport: () => notInElectron("notes.vaultExport") as never,
  },
  obsidian: {
    pickVault: () => Promise.resolve({ path: null }),
    sync: () => notInElectron("obsidian.sync") as never,
  },
  notion: {
    connect: () => Promise.resolve({ connected: false }),
    status: () => Promise.resolve({ connected: false }),
    disconnect: () => Promise.resolve(),
    listPages: () => Promise.resolve({ pages: [] }),
    setParent: () => notInElectron("notion.setParent") as never,
    sync: () => notInElectron("notion.sync") as never,
  },
  mp3: {
    probeFfmpeg: () =>
      Promise.resolve({ available: false, error: "Not in Electron" }),
    convert: () => Promise.resolve({ results: [] }),
    onProgress: () => () => {},
  },
  cover: {
    suggest: () =>
      Promise.resolve({ artist: "", album: "", term: "", results: [] }),
    search: () => Promise.resolve({ results: [] }),
  },
  ebook: {
    convert: () => notInElectron("ebook.convert") as never,
    preview: () => notInElectron("ebook.preview") as never,
    onProgress: () => () => {},
  },
  video: {
    probeFfmpeg: () =>
      Promise.resolve({ available: false, error: "Not in Electron" }),
    convert: () => notInElectron("video.convert") as never,
    onProgress: () => () => {},
    probe: () => notInElectron("video.probe") as never,
    preview: () => notInElectron("video.preview") as never,
  },
  firmware: {
    detect: () =>
      Promise.resolve({ device: null, dfuUtilAvailable: false }),
    flash: () => notInElectron("firmware.flash") as never,
    cancel: () => Promise.resolve(),
    onProgress: () => () => {},
    onLog: () => () => {},
    update: {
      getState: () =>
        Promise.resolve({
          latest: null,
          binCached: false,
          binPath: null,
          fetchError: null,
          integrityError: null,
          fetching: false,
          lastFetchedAt: null,
        }),
      refresh: () => notInElectron("firmware.update.refresh") as never,
      onState: () => () => {},
      readSdVersion: () => Promise.resolve({ version: null }),
      triggerDfu: () => notInElectron("firmware.update.triggerDfu") as never,
      flashCached: () => notInElectron("firmware.update.flashCached") as never,
      ackIntegrityError: () =>
        notInElectron("firmware.update.ackIntegrityError") as never,
    },
  },

  files: {
    list: () => notInElectron("files.list") as never,
    del: () => notInElectron("files.del") as never,
    upload: () => notInElectron("files.upload") as never,
    mkdir: () => notInElectron("files.mkdir") as never,
    rename: () => notInElectron("files.rename") as never,
    copy: () => notInElectron("files.copy") as never,
    move: () => notInElectron("files.move") as never,
  },
  fs: {
    getPathForFile: () => "",
    expandAudioPaths: () => Promise.resolve([]),
    chooseDirectory: () => Promise.resolve(null),
    isDirectory: () => Promise.resolve(false),
  },
};

const impl = isElectron ? window.orion : stubOrion;

export const api: OrionAPI = {
  ping: (req: PingRequest) => impl.ping(req),
  system: {
    info: () => impl.system.info(),
  },
  device: {
    list: () => impl.device.list(),
    startWatch: () => impl.device.startWatch(),
    stopWatch: () => impl.device.stopWatch(),
    onChanged: (cb) => impl.device.onChanged(cb),
    eject: (req) => impl.device.eject(req),
  },
  storage: {
    read: (req) => impl.storage.read(req),
  },
  ble: {
    mirrorState: () => impl.ble.mirrorState(),
    mirrorWrite: (req) => impl.ble.mirrorWrite(req),
    mirrorRead: (req) => impl.ble.mirrorRead(req),
    mirrorDelete: (req) => impl.ble.mirrorDelete(req),
    mirrorMkdir: (req) => impl.ble.mirrorMkdir(req),
    mirrorSaveSnapshot: (s) => impl.ble.mirrorSaveSnapshot(s),
    readLocal: (req) => impl.ble.readLocal(req),
    tmpDir: () => impl.ble.tmpDir(),
  },
  calendario: {
    permesso: () => impl.calendario.permesso(),
    elenco: () => impl.calendario.elenco(),
    anteprima: (req) => impl.calendario.anteprima(req),
    scrivi: (req) => impl.calendario.scrivi(req),
    dati: (req) => impl.calendario.dati(req),
  },
  notes: {
    list: (req) => impl.notes.list(req),
    tree: (req) => impl.notes.tree(req),
    read: (req) => impl.notes.read(req),
    backup: (req) => impl.notes.backup(req),
    backupAll: (req) => impl.notes.backupAll(req),
    defaults: () => impl.notes.defaults(),
    revealBackupDir: (p) => impl.notes.revealBackupDir(p),
    mkdir: (req) => impl.notes.mkdir(req),
    rename: (req) => impl.notes.rename(req),
    del: (req) => impl.notes.del(req),
    copy: (req) => impl.notes.copy(req),
    move: (req) => impl.notes.move(req),
    vaultStatus: (req) => impl.notes.vaultStatus(req),
    vaultUnlock: (req) => impl.notes.vaultUnlock(req),
    vaultLock: (req) => impl.notes.vaultLock(req),
    vaultImport: (req) => impl.notes.vaultImport(req),
    vaultExport: (req) => impl.notes.vaultExport(req),
  },
  obsidian: {
    pickVault: () => impl.obsidian.pickVault(),
    sync: (req) => impl.obsidian.sync(req),
  },
  notion: {
    connect: () => impl.notion.connect(),
    status: () => impl.notion.status(),
    disconnect: () => impl.notion.disconnect(),
    listPages: () => impl.notion.listPages(),
    setParent: (req) => impl.notion.setParent(req),
    sync: (req) => impl.notion.sync(req),
  },
  mp3: {
    probeFfmpeg: () => impl.mp3.probeFfmpeg(),
    convert: (req) => impl.mp3.convert(req),
    onProgress: (cb) => impl.mp3.onProgress(cb),
  },
  cover: {
    suggest: (req) => impl.cover.suggest(req),
    search: (req) => impl.cover.search(req),
  },
  ebook: {
    convert: (req) => impl.ebook.convert(req),
    preview: (req) => impl.ebook.preview(req),
    onProgress: (cb) => impl.ebook.onProgress(cb),
  },
  video: {
    probeFfmpeg: () => impl.video.probeFfmpeg(),
    convert: (req) => impl.video.convert(req),
    onProgress: (cb) => impl.video.onProgress(cb),
    probe: (req) => impl.video.probe(req),
    preview: (req) => impl.video.preview(req),
  },
  firmware: {
    detect: () => impl.firmware.detect(),
    flash: (req) => impl.firmware.flash(req),
    cancel: () => impl.firmware.cancel(),
    onProgress: (cb) => impl.firmware.onProgress(cb),
    onLog: (cb) => impl.firmware.onLog(cb),
    update: {
      getState: () => impl.firmware.update.getState(),
      refresh: () => impl.firmware.update.refresh(),
      onState: (cb) => impl.firmware.update.onState(cb),
      readSdVersion: (req) => impl.firmware.update.readSdVersion(req),
      triggerDfu: (req) => impl.firmware.update.triggerDfu(req),
      flashCached: () => impl.firmware.update.flashCached(),
      ackIntegrityError: () => impl.firmware.update.ackIntegrityError(),
    },
  },
  files: {
    list: (req) => impl.files.list(req),
    del: (req) => impl.files.del(req),
    upload: (req) => impl.files.upload(req),
    mkdir: (req) => impl.files.mkdir(req),
    rename: (req) => impl.files.rename(req),
    copy: (req) => impl.files.copy(req),
    move: (req) => impl.files.move(req),
  },
  fs: {
    getPathForFile: (file) => impl.fs.getPathForFile(file),
    expandAudioPaths: (paths) => impl.fs.expandAudioPaths(paths),
    chooseDirectory: () => impl.fs.chooseDirectory(),
    isDirectory: (p) => impl.fs.isDirectory(p),
  },
};
