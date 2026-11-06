import { useEffect, useState } from "react";
import Sidebar, { SIDEBAR_ITEMS } from "./components/Sidebar";
import Header from "./components/Header";
import IntegrityErrorDialog from "./components/IntegrityErrorDialog";
import BugReportModal from "./components/BugReportModal";
import { DeviceProvider } from "./lib/DeviceContext";
import { ThemeProvider } from "./lib/ThemeContext";
import { FirmwareUpdateProvider, useFirmwareUpdate } from "./lib/FirmwareUpdateContext";
import { ActivityProvider } from "./lib/ActivityContext";
import HomePage from "./pages/HomePage";
import DevicePage from "./pages/DevicePage";
import NotesPage from "./pages/NotesPage";
import MusicPage from "./pages/MusicPage";
import VideoPage from "./pages/VideoPage";
import EbookPage from "./pages/EbookPage";
import CalendarPage from "./pages/CalendarPage";
import FilesPage from "./pages/FilesPage";
import FirmwarePage from "./pages/FirmwarePage";
import PlaceholderPage from "./components/PlaceholderPage";

type PageKey = (typeof SIDEBAR_ITEMS)[number]["key"];

const PAGE_META: Record<
  PageKey,
  { title: string; subtitle?: string }
> = {
  home:     { title: "Home" },
  device:   { title: "Device",   subtitle: "Connected USB MSC volumes recognized as Orion." },
  notes:    { title: "Notes",    subtitle: "Backup and sync your notes, over USB or Bluetooth." },
  ebooks:   { title: "Ebooks",   subtitle: "Convert EPUB / PDF / Markdown to .pdar." },
  music:    { title: "Music",    subtitle: "Convert and upload MP3 to the device." },
  video:    { title: "Video",    subtitle: "Convert MP4 / MKV to the .av format." },
  calendar: { title: "Calendar", subtitle: "Send your Mac calendar to the device." },
  files:    { title: "Files",    subtitle: "Browse, upload, delete files on the device SD card." },
  firmware: { title: "Firmware", subtitle: "Update the Orion firmware via DFU." },
};

const Shell = () => {
  const [active, setActive] = useState<PageKey>("home");
  const [bugReportOpen, setBugReportOpen] = useState(false);
  const meta = PAGE_META[active];
  const { updateAvailable, justBecameAvailable, ackBlink } = useFirmwareUpdate();

  // Auto-navigate to Firmware the first time an update becomes available.
  useEffect(() => {
    if (justBecameAvailable) {
      setActive("firmware");
      ackBlink();
    }
  }, [justBecameAvailable, ackBlink]);

  const renderPage = () => {
    switch (active) {
      case "home":     return <HomePage onNavigate={(k) => setActive(k as PageKey)} />;
      case "device":   return <DevicePage />;
      case "notes":    return <NotesPage />;
      case "music":    return <MusicPage />;
      case "video":    return <VideoPage />;
      case "ebooks":   return <EbookPage />;
      case "calendar": return <CalendarPage />;
      case "files":    return <FilesPage />;
      case "firmware": return <FirmwarePage />;
      case "calendar":
        return (
          <PlaceholderPage
            title="Calendar"
            roadmapStep="Backlog"
            description="RTC sync + basic events. Feature not yet planned in roadmap."
          />
        );
    }
  };

  return (
    <div className="flex h-full">
      <Sidebar
        active={active}
        onSelect={(k) => setActive(k as PageKey)}
        firmwareUpdateAvailable={updateAvailable && active !== "firmware"}
        onOpenBugReport={() => setBugReportOpen(true)}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header title={meta.title} subtitle={meta.subtitle} />
        <main className="flex-1 overflow-auto p-8">
          {renderPage()}
        </main>
      </div>
      <IntegrityErrorDialog />
      <BugReportModal
        open={bugReportOpen}
        onClose={() => setBugReportOpen(false)}
      />
    </div>
  );
};

const App = () => (
  <ThemeProvider>
    <DeviceProvider>
      <ActivityProvider>
        <FirmwareUpdateProvider>
          <Shell />
        </FirmwareUpdateProvider>
      </ActivityProvider>
    </DeviceProvider>
  </ThemeProvider>
);

export default App;
