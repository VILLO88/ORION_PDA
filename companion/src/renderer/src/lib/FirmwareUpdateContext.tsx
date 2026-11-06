import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from "react";
import { api, isElectron } from "./api";
import { useDevices } from "./DeviceContext";
import type { FirmwareUpdateState } from "@shared/ipc-types";

/**
 * Firmware update context — wires together:
 *   - background manifest/bin fetch state from main
 *   - SD version read from the connected device
 *   - "update available" computation + a one-shot blink signal
 *
 * `updateAvailable` is true when both versions are known AND differ.
 * `justBecameAvailable` flips true exactly once per session, used by the
 * shell to auto-navigate to the Firmware page the first time we see it.
 */

const EMPTY_STATE: FirmwareUpdateState = {
  latest: null,
  binCached: false,
  binPath: null,
  fetchError: null,
  integrityError: null,
  fetching: false,
  lastFetchedAt: null,
};

interface FirmwareUpdateContextValue {
  /** Main-process side state (manifest + cache status). */
  state: FirmwareUpdateState;
  /** Version string read from the connected device's SD root, or null. */
  deviceVersion: string | null;
  /** True if both versions known and they differ. */
  updateAvailable: boolean;
  /** Becomes true exactly once when updateAvailable first becomes true. */
  justBecameAvailable: boolean;
  /** Acknowledge `justBecameAvailable` so it resets to false. */
  ackBlink: () => void;
  /** Force a manifest refresh. */
  refresh: () => Promise<void>;
  /** Re-read the SD version (e.g. after a flash). */
  refreshDeviceVersion: () => Promise<void>;
  /** Acknowledge the integrityError (clears it on the main side). */
  ackIntegrityError: () => Promise<void>;
}

const FirmwareUpdateContext = createContext<FirmwareUpdateContextValue>({
  state: EMPTY_STATE,
  deviceVersion: null,
  updateAvailable: false,
  justBecameAvailable: false,
  ackBlink: () => undefined,
  refresh: async () => undefined,
  refreshDeviceVersion: async () => undefined,
  ackIntegrityError: async () => undefined,
});

interface ProviderProps {
  children: ReactNode;
}

/** Natural version compare. Handles `1.2.3` as well as alphanumeric
 *  tags like `01beta` < `02beta`. Embedded numbers sort by value, not
 *  lexically. */
function compareVersions(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export const FirmwareUpdateProvider: FC<ProviderProps> = ({ children }) => {
  const { devices } = useDevices();
  const device = devices[0] ?? null;

  const [state, setState] = useState<FirmwareUpdateState>(EMPTY_STATE);
  const [deviceVersion, setDeviceVersion] = useState<string | null>(null);
  const [justBecameAvailable, setJustBecameAvailable] = useState(false);
  const sawAvailableRef = useRef(false);

  // ---- Subscribe to main-side state -------------------------------------
  useEffect(() => {
    if (!isElectron) return;
    let mounted = true;
    void api.firmware.update.getState().then((s) => {
      if (mounted) setState(s);
    });
    const unsub = api.firmware.update.onState((s) => {
      if (mounted) setState(s);
    });
    return () => {
      mounted = false;
      unsub();
    };
  }, []);

  // ---- Read SD version whenever a device shows up / changes -------------
  const readDeviceVersion = useCallback(async () => {
    if (!device) {
      setDeviceVersion(null);
      return;
    }
    try {
      const r = await api.firmware.update.readSdVersion({
        mountPath: device.mountPath,
      });
      // Fallback to marker fw_version if .fwver file isn't present yet
      // (legacy firmware compatibility).
      setDeviceVersion(r.version ?? device.fwVersion ?? null);
    } catch {
      setDeviceVersion(device.fwVersion ?? null);
    }
  }, [device]);

  useEffect(() => {
    void readDeviceVersion();
  }, [readDeviceVersion]);

  // ---- Compute updateAvailable + edge-trigger blink ---------------------
  const updateAvailable = useMemo(() => {
    if (!state.latest || !deviceVersion) return false;
    if (!state.binCached) return false; // need a usable .bin
    return compareVersions(deviceVersion, state.latest.version) < 0;
  }, [state.latest, state.binCached, deviceVersion]);

  useEffect(() => {
    if (updateAvailable && !sawAvailableRef.current) {
      sawAvailableRef.current = true;
      setJustBecameAvailable(true);
    }
    if (!updateAvailable) {
      // Reset so the next time we detect an update we blink again.
      sawAvailableRef.current = false;
    }
  }, [updateAvailable]);

  const ackBlink = useCallback(() => setJustBecameAvailable(false), []);

  const refresh = useCallback(async () => {
    if (!isElectron) return;
    const s = await api.firmware.update.refresh();
    setState(s);
  }, []);

  const ackIntegrityError = useCallback(async () => {
    if (!isElectron) return;
    const s = await api.firmware.update.ackIntegrityError();
    setState(s);
  }, []);

  const value = useMemo<FirmwareUpdateContextValue>(
    () => ({
      state,
      deviceVersion,
      updateAvailable,
      justBecameAvailable,
      ackBlink,
      refresh,
      refreshDeviceVersion: readDeviceVersion,
      ackIntegrityError,
    }),
    [
      state,
      deviceVersion,
      updateAvailable,
      justBecameAvailable,
      ackBlink,
      refresh,
      readDeviceVersion,
      ackIntegrityError,
    ],
  );

  return (
    <FirmwareUpdateContext.Provider value={value}>
      {children}
    </FirmwareUpdateContext.Provider>
  );
};

export const useFirmwareUpdate = (): FirmwareUpdateContextValue =>
  useContext(FirmwareUpdateContext);
