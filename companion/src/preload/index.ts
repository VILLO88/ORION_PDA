import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  CalendarioAnteprima,
  BleMirrorState,
  BleSnapshot,
  CalendarioDatiResponse,
  CalendarioFinestra,
  CalendarioPermessoResponse,
  CalendarioScriviRequest,
  CalendarioScriviResponse,
  CalendariListResponse,
  DeviceChangedListener,
  DeviceEjectRequest,
  DeviceEjectResponse,
  DeviceListResponse,
  DeviceStorageRequest,
  DeviceStorageResponse,
  EbookConvertRequest,
  EbookConvertResponse,
  EbookPreviewRequest,
  EbookPreviewResponse,
  EbookProgressEvent,
  EbookProgressListener,
  FilesCopyRequest,
  FilesCopyResponse,
  FilesDeleteRequest,
  FilesListRequest,
  FilesListResponse,
  FilesMkdirRequest,
  FilesMkdirResponse,
  FilesMoveRequest,
  FilesMoveResponse,
  FilesRenameRequest,
  FilesUploadRequest,
  FilesUploadResponse,
  FirmwareDetectResponse,
  FirmwareDfuTriggerRequest,
  FirmwareDfuTriggerResponse,
  FirmwareFlashProgress,
  FirmwareFlashRequest,
  FirmwareFlashResult,
  FirmwareLogListener,
  FirmwareProgressListener,
  FirmwareSdVersionRequest,
  FirmwareSdVersionResponse,
  FirmwareUpdateState,
  FirmwareUpdateStateListener,
  FfmpegProbe,
  Mp3ConvertRequest,
  Mp3ConvertResponse,
  Mp3ProgressEvent,
  Mp3ProgressListener,
  CoverSuggestRequest,
  CoverSuggestResponse,
  CoverSearchRequest,
  CoverSearchResponse,
  NoteBackupAllRequest,
  NoteBackupAllResponse,
  NoteBackupRequest,
  NoteBackupResponse,
  NoteCopyRequest,
  NoteCopyResponse,
  NoteDefaultsResponse,
  NoteDeleteRequest,
  NoteListRequest,
  NoteListResponse,
  NoteMkdirRequest,
  NoteMkdirResponse,
  NoteMoveRequest,
  NoteVaultExport,
  NoteVaultImportRequest,
  NoteVaultRequest,
  NoteVaultStatus,
  NoteVaultUnlockRequest,
  NoteMoveResponse,
  NoteReadRequest,
  NoteReadResponse,
  NoteRenameRequest,
  NoteRenameResponse,
  NoteTreeRequest,
  NoteTreeResponse,
  ObsidianPickVaultResponse,
  ObsidianSyncRequest,
  ObsidianSyncResponse,
  NotionConnectResponse,
  NotionListPagesResponse,
  NotionSetParentRequest,
  NotionStatusResponse,
  NotionSyncRequest,
  NotionSyncResponse,
  OrionAPI,
  PingRequest,
  PingResponse,
  SystemInfo,
  VideoConvertRequest,
  VideoConvertResponse,
  VideoPreviewRequest,
  VideoPreviewResponse,
  VideoProbeRequest,
  VideoProbeResponse,
  VideoProgressEvent,
  VideoProgressListener,
  WikiConvertRequest,
  WikiConvertResponse,
  WikiInfoResponse,
  WikiProgressEvent,
  WikiProgressListener,
} from "../shared/ipc-types";

const api: OrionAPI = {
  ping: (req: PingRequest) =>
    ipcRenderer.invoke("ping", req) as Promise<PingResponse>,

  system: {
    info: () => ipcRenderer.invoke("system:info") as Promise<SystemInfo>,
  },

  device: {
    list: () =>
      ipcRenderer.invoke("device:list") as Promise<DeviceListResponse>,
    startWatch: () =>
      ipcRenderer.invoke("device:watch:start") as Promise<void>,
    stopWatch: () =>
      ipcRenderer.invoke("device:watch:stop") as Promise<void>,
    eject: (req: DeviceEjectRequest) =>
      ipcRenderer.invoke("device:eject", req) as Promise<DeviceEjectResponse>,
    onChanged: (cb: DeviceChangedListener) => {
      const handler = (_e: unknown, devices: unknown) => {
        cb(devices as Parameters<DeviceChangedListener>[0]);
      };
      ipcRenderer.on("device:changed", handler);
      return () => {
        ipcRenderer.removeListener("device:changed", handler);
      };
    },
  },

  storage: {
    read: (req: DeviceStorageRequest) =>
      ipcRenderer.invoke("storage:read", req) as Promise<DeviceStorageResponse>,
  },

  ble: {
    mirrorState: () => ipcRenderer.invoke("ble:mirrorState") as Promise<BleMirrorState>,
    mirrorWrite: (req: { rel: string; dati: Uint8Array }) =>
      ipcRenderer.invoke("ble:mirrorWrite", req) as Promise<void>,
    mirrorRead: (req: { rel: string }) =>
      ipcRenderer.invoke("ble:mirrorRead", req) as Promise<Uint8Array>,
    mirrorDelete: (req: { rel: string }) =>
      ipcRenderer.invoke("ble:mirrorDelete", req) as Promise<void>,
    mirrorMkdir: (req: { rel: string }) =>
      ipcRenderer.invoke("ble:mirrorMkdir", req) as Promise<void>,
    mirrorSaveSnapshot: (s: BleSnapshot) =>
      ipcRenderer.invoke("ble:mirrorSaveSnapshot", s) as Promise<void>,
    readLocal: (req: { path: string }) =>
      ipcRenderer.invoke("ble:readLocal", req) as Promise<{ nome: string; dati: Uint8Array }>,
    tmpDir: () => ipcRenderer.invoke("ble:tmpDir") as Promise<string>,
  },

  calendario: {
    permesso: () =>
      ipcRenderer.invoke("calendario:permesso") as Promise<CalendarioPermessoResponse>,
    elenco: () =>
      ipcRenderer.invoke("calendario:elenco") as Promise<CalendariListResponse>,
    anteprima: (req: CalendarioFinestra) =>
      ipcRenderer.invoke("calendario:anteprima", req) as Promise<CalendarioAnteprima>,
    scrivi: (req: CalendarioScriviRequest) =>
      ipcRenderer.invoke("calendario:scrivi", req) as Promise<CalendarioScriviResponse>,
    dati: (req: CalendarioFinestra) =>
      ipcRenderer.invoke("calendario:dati", req) as Promise<CalendarioDatiResponse>,
  },

  notes: {
    list: (req: NoteListRequest) =>
      ipcRenderer.invoke("notes:list", req) as Promise<NoteListResponse>,
    tree: (req: NoteTreeRequest) =>
      ipcRenderer.invoke("notes:tree", req) as Promise<NoteTreeResponse>,
    read: (req: NoteReadRequest) =>
      ipcRenderer.invoke("notes:read", req) as Promise<NoteReadResponse>,
    backup: (req: NoteBackupRequest) =>
      ipcRenderer.invoke("notes:backup", req) as Promise<NoteBackupResponse>,
    backupAll: (req: NoteBackupAllRequest) =>
      ipcRenderer.invoke("notes:backupAll", req) as Promise<NoteBackupAllResponse>,
    defaults: () =>
      ipcRenderer.invoke("notes:defaults") as Promise<NoteDefaultsResponse>,
    revealBackupDir: (p: string) =>
      ipcRenderer.invoke("notes:reveal", p) as Promise<void>,
    mkdir: (req: NoteMkdirRequest) =>
      ipcRenderer.invoke("notes:mkdir", req) as Promise<NoteMkdirResponse>,
    rename: (req: NoteRenameRequest) =>
      ipcRenderer.invoke("notes:rename", req) as Promise<NoteRenameResponse>,
    del: (req: NoteDeleteRequest) =>
      ipcRenderer.invoke("notes:delete", req) as Promise<void>,
    copy: (req: NoteCopyRequest) =>
      ipcRenderer.invoke("notes:copy", req) as Promise<NoteCopyResponse>,
    move: (req: NoteMoveRequest) =>
      ipcRenderer.invoke("notes:move", req) as Promise<NoteMoveResponse>,
    vaultStatus: (req: NoteVaultRequest) =>
      ipcRenderer.invoke("notes:vaultStatus", req) as Promise<NoteVaultStatus>,
    vaultUnlock: (req: NoteVaultUnlockRequest) =>
      ipcRenderer.invoke("notes:vaultUnlock", req) as Promise<NoteVaultStatus>,
    vaultLock: (req: NoteVaultRequest) =>
      ipcRenderer.invoke("notes:vaultLock", req) as Promise<NoteVaultStatus>,
    vaultImport: (req: NoteVaultImportRequest) =>
      ipcRenderer.invoke("notes:vaultImport", req) as Promise<NoteVaultStatus>,
    vaultExport: (req: NoteVaultUnlockRequest) =>
      ipcRenderer.invoke("notes:vaultExport", req) as Promise<NoteVaultExport>,
  },

  obsidian: {
    pickVault: () =>
      ipcRenderer.invoke("obsidian:pickVault") as Promise<ObsidianPickVaultResponse>,
    sync: (req: ObsidianSyncRequest) =>
      ipcRenderer.invoke("obsidian:sync", req) as Promise<ObsidianSyncResponse>,
  },

  notion: {
    connect: () =>
      ipcRenderer.invoke("notion:connect") as Promise<NotionConnectResponse>,
    status: () =>
      ipcRenderer.invoke("notion:status") as Promise<NotionStatusResponse>,
    disconnect: () => ipcRenderer.invoke("notion:disconnect") as Promise<void>,
    listPages: () =>
      ipcRenderer.invoke("notion:listPages") as Promise<NotionListPagesResponse>,
    setParent: (req: NotionSetParentRequest) =>
      ipcRenderer.invoke("notion:setParent", req) as Promise<void>,
    sync: (req: NotionSyncRequest) =>
      ipcRenderer.invoke("notion:sync", req) as Promise<NotionSyncResponse>,
  },

  mp3: {
    probeFfmpeg: () =>
      ipcRenderer.invoke("mp3:probe") as Promise<FfmpegProbe>,
    convert: (req: Mp3ConvertRequest) =>
      ipcRenderer.invoke("mp3:convert", req) as Promise<Mp3ConvertResponse>,
    onProgress: (cb: Mp3ProgressListener) => {
      const handler = (_e: unknown, ev: unknown) =>
        cb(ev as Mp3ProgressEvent);
      ipcRenderer.on("mp3:progress", handler);
      return () => ipcRenderer.removeListener("mp3:progress", handler);
    },
  },

  cover: {
    suggest: (req: CoverSuggestRequest) =>
      ipcRenderer.invoke("cover:suggest", req) as Promise<CoverSuggestResponse>,
    search: (req: CoverSearchRequest) =>
      ipcRenderer.invoke("cover:search", req) as Promise<CoverSearchResponse>,
  },

  ebook: {
    convert: (req: EbookConvertRequest) =>
      ipcRenderer.invoke("ebook:convert", req) as Promise<EbookConvertResponse>,
    preview: (req: EbookPreviewRequest) =>
      ipcRenderer.invoke("ebook:preview", req) as Promise<EbookPreviewResponse>,
    onProgress: (cb: EbookProgressListener) => {
      const handler = (_e: unknown, ev: unknown) =>
        cb(ev as EbookProgressEvent);
      ipcRenderer.on("ebook:progress", handler);
      return () => ipcRenderer.removeListener("ebook:progress", handler);
    },
  },

  store: {
    account: () => ipcRenderer.invoke("store:account"),
    signIn: () => ipcRenderer.invoke("store:signIn"),
    signOut: () => ipcRenderer.invoke("store:signOut"),
    list: (req) => ipcRenderer.invoke("store:list", req),
    detail: (slug) => ipcRenderer.invoke("store:detail", slug),
    reviews: (slug) => ipcRenderer.invoke("store:reviews", slug),
    review: (req) => ipcRenderer.invoke("store:review", req),
    deleteReview: (slug) => ipcRenderer.invoke("store:deleteReview", slug),
    report: (req) => ipcRenderer.invoke("store:report", req),
    installed: (mountPath) => ipcRenderer.invoke("store:installed", mountPath),
    install: (req) => ipcRenderer.invoke("store:install", req),
    uninstall: (req) => ipcRenderer.invoke("store:uninstall", req),
    pickSource: () => ipcRenderer.invoke("store:pickSource"),
    readSource: (p) => ipcRenderer.invoke("store:readSource", p),
    publish: (req) => ipcRenderer.invoke("store:publish", req),
    pickScreenshots: () => ipcRenderer.invoke("store:pickScreenshots"),
    screenshot: (slug, version, index) => ipcRenderer.invoke("store:screenshot", slug, version, index),
    tryFiles: (slug, version) => ipcRenderer.invoke("store:tryFiles", slug, version),
    packageFiles: (slug, version) => ipcRenderer.invoke("store:packageFiles", slug, version),
    localFiles: (p, ex) => ipcRenderer.invoke("store:localFiles", p, ex),
    saveCapture: (d) => ipcRenderer.invoke("store:saveCapture", d),
    myApps: () => ipcRenderer.invoke("store:myApps"),
    withdraw: (id) => ipcRenderer.invoke("store:withdraw", id),
    queue: () => ipcRenderer.invoke("store:queue"),
    decide: (req) => ipcRenderer.invoke("store:decide", req),
    setHidden: (slug, hidden) => ipcRenderer.invoke("store:setHidden", slug, hidden),
    hideReview: (id) => ipcRenderer.invoke("store:hideReview", id),
    reports: () => ipcRenderer.invoke("store:reports"),
    resolveReport: (id) => ipcRenderer.invoke("store:resolveReport", id),
    ban: (login, banned) => ipcRenderer.invoke("store:ban", login, banned),
  },
  wiki: {
    info: (zimPath: string) =>
      ipcRenderer.invoke("wiki:info", zimPath) as Promise<WikiInfoResponse>,
    space: (dir: string) => ipcRenderer.invoke("wiki:space", dir) as Promise<number>,
    convert: (req: WikiConvertRequest) =>
      ipcRenderer.invoke("wiki:convert", req) as Promise<WikiConvertResponse>,
    cancel: () => ipcRenderer.invoke("wiki:cancel") as Promise<void>,
    onProgress: (cb: WikiProgressListener) => {
      const handler = (_e: unknown, ev: unknown) => cb(ev as WikiProgressEvent);
      ipcRenderer.on("wiki:progress", handler);
      return () => ipcRenderer.removeListener("wiki:progress", handler);
    },
  },

  video: {
    probeFfmpeg: () =>
      ipcRenderer.invoke("video:probe") as Promise<FfmpegProbe>,
    convert: (req: VideoConvertRequest) =>
      ipcRenderer.invoke("video:convert", req) as Promise<VideoConvertResponse>,
    onProgress: (cb: VideoProgressListener) => {
      const handler = (_e: unknown, ev: unknown) =>
        cb(ev as VideoProgressEvent);
      ipcRenderer.on("video:progress", handler);
      return () => ipcRenderer.removeListener("video:progress", handler);
    },
    probe: (req: VideoProbeRequest) =>
      ipcRenderer.invoke("video:probeSource", req) as Promise<VideoProbeResponse>,
    preview: (req: VideoPreviewRequest) =>
      ipcRenderer.invoke("video:preview", req) as Promise<VideoPreviewResponse>,
  },

  firmware: {
    detect: () =>
      ipcRenderer.invoke("firmware:detect") as Promise<FirmwareDetectResponse>,
    flash: (req: FirmwareFlashRequest) =>
      ipcRenderer.invoke("firmware:flash", req) as Promise<FirmwareFlashResult>,
    cancel: () => ipcRenderer.invoke("firmware:cancel") as Promise<void>,
    onProgress: (cb: FirmwareProgressListener) => {
      const handler = (_e: unknown, ev: unknown) =>
        cb(ev as FirmwareFlashProgress);
      ipcRenderer.on("firmware:progress", handler);
      return () => ipcRenderer.removeListener("firmware:progress", handler);
    },
    onLog: (cb: FirmwareLogListener) => {
      const handler = (_e: unknown, line: unknown) => cb(line as string);
      ipcRenderer.on("firmware:log", handler);
      return () => ipcRenderer.removeListener("firmware:log", handler);
    },
    update: {
      getState: () =>
        ipcRenderer.invoke("firmware:update:getState") as Promise<FirmwareUpdateState>,
      refresh: () =>
        ipcRenderer.invoke("firmware:update:refresh") as Promise<FirmwareUpdateState>,
      onState: (cb: FirmwareUpdateStateListener) => {
        const handler = (_e: unknown, s: unknown) =>
          cb(s as FirmwareUpdateState);
        ipcRenderer.on("firmware:update:state", handler);
        return () =>
          ipcRenderer.removeListener("firmware:update:state", handler);
      },
      readSdVersion: (req: FirmwareSdVersionRequest) =>
        ipcRenderer.invoke(
          "firmware:update:readSdVersion",
          req,
        ) as Promise<FirmwareSdVersionResponse>,
      triggerDfu: (req: FirmwareDfuTriggerRequest) =>
        ipcRenderer.invoke(
          "firmware:update:triggerDfu",
          req,
        ) as Promise<FirmwareDfuTriggerResponse>,
      flashCached: () =>
        ipcRenderer.invoke(
          "firmware:update:flashCached",
        ) as Promise<FirmwareFlashResult>,
      ackIntegrityError: () =>
        ipcRenderer.invoke(
          "firmware:update:ackIntegrityError",
        ) as Promise<FirmwareUpdateState>,
    },
  },

  files: {
    list: (req: FilesListRequest) =>
      ipcRenderer.invoke("files:list", req) as Promise<FilesListResponse>,
    del: (req: FilesDeleteRequest) =>
      ipcRenderer.invoke("files:delete", req) as Promise<void>,
    upload: (req: FilesUploadRequest) =>
      ipcRenderer.invoke("files:upload", req) as Promise<FilesUploadResponse>,
    mkdir: (req: FilesMkdirRequest) =>
      ipcRenderer.invoke("files:mkdir", req) as Promise<FilesMkdirResponse>,
    rename: (req: FilesRenameRequest) =>
      ipcRenderer.invoke("files:rename", req) as Promise<void>,
    copy: (req: FilesCopyRequest) =>
      ipcRenderer.invoke("files:copy", req) as Promise<FilesCopyResponse>,
    move: (req: FilesMoveRequest) =>
      ipcRenderer.invoke("files:move", req) as Promise<FilesMoveResponse>,
  },

  fs: {
    getPathForFile: (file: File): string => webUtils.getPathForFile(file),
    expandAudioPaths: (paths: string[]) =>
      ipcRenderer.invoke("fs:expandAudioPaths", paths) as Promise<string[]>,
    chooseDirectory: () =>
      ipcRenderer.invoke("fs:chooseDirectory") as Promise<string | null>,
    isDirectory: (p: string) =>
      ipcRenderer.invoke("fs:isDirectory", p) as Promise<boolean>,
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("orion", api);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
  }
} else {
  (globalThis as unknown as { orion: OrionAPI }).orion = api;
}

declare global {
  interface Window {
    orion: OrionAPI;
  }
}
