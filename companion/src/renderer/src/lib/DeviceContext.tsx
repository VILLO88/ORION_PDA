import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FC,
  type ReactNode,
} from "react";
import type { DeviceInfo } from "@shared/ipc-types";
import { api, isElectron } from "./api";

interface DeviceContextValue {
  devices: DeviceInfo[];
  /** Lista già caricata almeno una volta dal main. */
  ready: boolean;
  /** Riscan immediato (utile per pulsante "Refresh"). */
  refresh: () => Promise<void>;
}

const DeviceContext = createContext<DeviceContextValue>({
  devices: [],
  ready: false,
  refresh: () => Promise.resolve(),
});

interface ProviderProps {
  children: ReactNode;
}

/** Provider singleton: avvia il watch del main al mount, espone lo stato. */
export const DeviceProvider: FC<ProviderProps> = ({ children }) => {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isElectron) {
      setReady(true);
      return;
    }
    let mounted = true;

    const unsub = api.device.onChanged((d) => {
      if (mounted) setDevices(d);
    });

    void (async () => {
      try {
        const r = await api.device.list();
        if (mounted) {
          setDevices(r.devices);
          setReady(true);
        }
        await api.device.startWatch();
      } catch (err) {
        console.error("device init failed", err);
        if (mounted) setReady(true);
      }
    })();

    return () => {
      mounted = false;
      unsub();
      void api.device.stopWatch();
    };
  }, []);

  const value = useMemo<DeviceContextValue>(
    () => ({
      devices,
      ready,
      refresh: async () => {
        const r = await api.device.list();
        setDevices(r.devices);
      },
    }),
    [devices, ready],
  );

  return <DeviceContext.Provider value={value}>{children}</DeviceContext.Provider>;
};

export const useDevices = (): DeviceContextValue => useContext(DeviceContext);
