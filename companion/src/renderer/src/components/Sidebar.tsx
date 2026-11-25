import { useState, type FC } from "react";
import { BookOpen, Calendar, Cpu, FolderOpen, Globe, Home, LifeBuoy, Music2, StickyNote, Store, Video, Zap, type LucideIcon } from "lucide-react";
import { useDevices } from "@/lib/DeviceContext";
import logoUrl from "../../../../media/logo.png";

export interface SidebarItem {
  key: string;
  label: string;
  icon: LucideIcon;
}

export const SIDEBAR_ITEMS = [
  { key: "home",     label: "Home",     icon: Home },
  { key: "device",   label: "Device",   icon: Cpu },
  { key: "notes",    label: "Notes",    icon: StickyNote },
  { key: "ebooks",   label: "Ebooks",   icon: BookOpen },
  { key: "wiki",     label: "Wikipedia", icon: Globe },
  { key: "music",    label: "Music",    icon: Music2 },
  { key: "video",    label: "Video",    icon: Video },
  { key: "calendar", label: "Calendar", icon: Calendar },
  { key: "files",    label: "Files",    icon: FolderOpen },
  { key: "store",    label: "App Store", icon: Store },
  { key: "firmware", label: "Firmware", icon: Zap },
] as const satisfies readonly SidebarItem[];

interface Props {
  active: string;
  onSelect: (key: string) => void;
  /** Pulsing orange badge on the Firmware row (a new firmware is available). */
  firmwareUpdateAvailable?: boolean;
  /** Apre il modale Bug Report (azione, non navigazione). */
  onOpenBugReport: () => void;
}

const COLLAPSED_W = "4rem";   // 64px — solo icone
const EXPANDED_W  = "15rem";  // 240px — icone + label

const Sidebar: FC<Props> = ({
  active,
  onSelect,
  firmwareUpdateAvailable,
  onOpenBugReport,
}) => {
  const { devices, ready } = useDevices();
  const device = devices[0];

  const [hovered, setHovered] = useState(false);
  const expanded = hovered;

  return (
    <aside
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ width: expanded ? EXPANDED_W : COLLAPSED_W }}
      className="group/sidebar relative z-20 flex shrink-0 flex-col overflow-hidden border-r border-zinc-200 bg-white transition-[width] duration-200 ease-out dark:border-zinc-800 dark:bg-zinc-900"
    >
      {/* Logo + version */}
      <div className="flex flex-col items-center gap-1 px-3 py-5">
        <img
          src={logoUrl}
          alt="Orion"
          className="h-10 w-auto select-none dark:brightness-110"
          draggable={false}
        />
        <p
          className={`whitespace-nowrap text-[10px] font-medium uppercase tracking-wider text-zinc-400 transition-opacity duration-150 ${
            expanded ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          Companion · v{__APP_VERSION__}
        </p>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2">
        {SIDEBAR_ITEMS.map((it) => {
          const Icon = it.icon;
          const isActive = it.key === active;
          const showBadge =
            it.key === "firmware" && firmwareUpdateAvailable === true;
          return (
            <button
              key={it.key}
              type="button"
              onClick={() => onSelect(it.key)}
              title={it.label}
              className={`mb-0.5 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                isActive ? "sidebar-item-active" : "sidebar-item-idle"
              }`}
            >
              <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
                <Icon className="h-4 w-4" />
                {showBadge && (
                  <span className="pointer-events-none absolute -right-1 -top-1 h-2.5 w-2.5 animate-pulse rounded-full bg-accent shadow-[0_0_0_2px_white] dark:shadow-[0_0_0_2px_rgb(24,24,27)]" />
                )}
              </span>
              <span
                className={`flex-1 whitespace-nowrap text-left transition-opacity duration-150 ${
                  expanded ? "opacity-100" : "pointer-events-none opacity-0"
                }`}
              >
                {it.label}
              </span>
            </button>
          );
        })}
      </nav>

      {/* Help / Bug report — non è una pagina, apre un modale. */}
      <div className="px-2 pb-2">
        <button
          type="button"
          onClick={onOpenBugReport}
          title="Report a bug"
          className="mb-0.5 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium sidebar-item-idle"
        >
          <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
            <LifeBuoy className="h-4 w-4" />
          </span>
          <span
            className={`flex-1 whitespace-nowrap text-left transition-opacity duration-150 ${
              expanded ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
          >
            Help
          </span>
        </button>
      </div>

      {/* Footer: connection status */}
      <div className="border-t border-zinc-200 px-3 py-4 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              !ready
                ? "bg-zinc-400"
                : device
                  ? "bg-emerald-500"
                  : "bg-zinc-500"
            }`}
          />
          <span
            className={`whitespace-nowrap text-xs font-medium text-zinc-700 transition-opacity duration-150 dark:text-zinc-300 ${
              expanded ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
          >
            {!ready ? "Scanning…" : device ? "Connected" : "Disconnected"}
          </span>
        </div>
        {device && (
          <p
            className={`mt-1 truncate text-[11px] text-zinc-400 transition-opacity duration-150 ${
              expanded ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
          >
            {device.deviceId ?? device.label}
          </p>
        )}
      </div>
    </aside>
  );
};

export default Sidebar;
