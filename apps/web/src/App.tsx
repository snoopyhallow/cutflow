import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Clapperboard,
  Film,
  LayoutDashboard,
  Redo2,
  Settings,
  Sparkles,
  Undo2,
  Users,
} from "lucide-react";
import { getColdOpenDurationMs, getTotalDurationMs } from "./edl";
import { CreatorsPage } from "./pages/CreatorsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { EditorStudioPage } from "./pages/EditorStudioPage";
import { ExportsPage } from "./pages/ExportsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { useTimelineStore } from "./state/timelineStore";
import {
  createTransport,
  DemoTransport,
  type ClipProjectSummary,
  type ClipStatus,
  type CreatorProfile,
  type ExportSummary,
  type FeedItem,
  type HealthResponse,
  type JobSummary,
  type ProjectPeaks,
  type SourceSummary,
  type StorageSummary,
  type StudioTransport,
} from "./transport";

type StudioTab = "dashboard" | "creators" | "editor" | "exports" | "settings";

export default function App() {
  const [activeTab, setActiveTab] = useState<StudioTab>("dashboard");
  const [transport, setTransport] = useState<StudioTransport>(() => createTransport());
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [profiles, setProfiles] = useState<CreatorProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [projects, setProjects] = useState<ClipProjectSummary[]>([]);
  const [exportsList, setExportsList] = useState<ExportSummary[]>([]);
  const [exportingNow, setExportingNow] = useState(false);
  const [feedItems, setFeedItems] = useState<FeedItem[]>([]);
  const [storage, setStorage] = useState<StorageSummary | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activePeaks, setActivePeaks] = useState<ProjectPeaks | null>(null);
  const [editorBoundaries, setEditorBoundaries] = useState<string>("");
  const [keysPresent, setKeysPresent] = useState<Record<string, boolean>>({});
  const [statusMessage, setStatusMessage] = useState<string>("");
  const sseUnsubsRef = useRef<Map<string, () => void>>(new Map());

  const {
    edl,
    undoStack,
    redoStack,
    dirty,
    loadProject,
    markSaved,
    undo,
    redo,
  } = useTimelineStore();

  const refreshWorkspace = useCallback(async (activeTransport: StudioTransport) => {
    const [
      loadedProfiles,
      loadedSources,
      loadedJobs,
      loadedProjects,
      loadedExports,
      loadedFeed,
      loadedStorage,
      loadedSettings,
    ] = await Promise.all([
      activeTransport.listProfiles(),
      activeTransport.listSources(),
      activeTransport.listJobs(),
      activeTransport.listProjects(),
      activeTransport.listExports(),
      activeTransport.listFeed(),
      activeTransport.getStorageSummary(),
      activeTransport.getSettings(),
    ]);
    setProfiles(loadedProfiles);
    setSelectedProfileId((prev) => prev || loadedProfiles[0]?.id || "");
    setSources(loadedSources);
    setJobs(loadedJobs);
    setProjects(loadedProjects);
    setExportsList(loadedExports);
    setFeedItems(loadedFeed);
    setStorage(loadedStorage);
    setKeysPresent(loadedSettings.keys_present);
    const expCfg = loadedSettings.settings?.export as
      | { editor_boundaries?: string }
      | undefined;
    if (expCfg?.editor_boundaries) {
      setEditorBoundaries(expCfg.editor_boundaries);
    }
    return loadedProjects;
  }, []);

  const loadEditorProject = useCallback(
    async (activeTransport: StudioTransport, projectId: string) => {
      const tl = await activeTransport.getTimeline(projectId);
      setActiveProjectId(projectId);
      loadProject(tl.edl, tl.sliceOriginMs ?? 0);
      try {
        const peaks = await activeTransport.getProjectPeaks(projectId);
        setActivePeaks(peaks);
      } catch {
        setActivePeaks(null);
      }
    },
    [loadProject],
  );

  const attachJobStream = useCallback(
    (activeTransport: StudioTransport, jobId: string) => {
      if (sseUnsubsRef.current.has(jobId)) return;
      const unsub = activeTransport.subscribeJobEvents(jobId, (evt) => {
        setJobs((prev) =>
          prev.map((j) =>
            j.id === evt.jobId
              ? {
                  ...j,
                  status: evt.status,
                  stage: evt.stage,
                  progress: evt.progress,
                  error: evt.error,
                  hypeCurve: evt.hypeCurve ?? j.hypeCurve,
                  clipCount: evt.clipsCreated ?? evt.projectIds?.length ?? j.clipCount,
                }
              : j,
          ),
        );
        if (evt.status === "done" || evt.status === "failed") {
          sseUnsubsRef.current.get(jobId)?.();
          sseUnsubsRef.current.delete(jobId);
          void refreshWorkspace(activeTransport);
        }
      });
      sseUnsubsRef.current.set(jobId, unsub);
    },
    [refreshWorkspace],
  );

  // Bootstrap connection: try local backend first, gracefully fall back to DemoTransport
  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      let active: StudioTransport = transport;
      try {
        const h = await active.health();
        if (!cancelled) setHealth(h);
      } catch {
        const demo = new DemoTransport();
        active = demo;
        if (!cancelled) {
          setTransport(demo);
          setHealth(await demo.health());
        }
      }

      const loadedProjects = await refreshWorkspace(active);
      if (cancelled) return;

      if (loadedProjects.length > 0) {
        await loadEditorProject(active, loadedProjects[0].id);
      } else {
        const fallback = new DemoTransport();
        const tl = await fallback.getTimeline("clip_demo_001");
        const peaks = await fallback.getProjectPeaks("clip_demo_001");
        if (!cancelled) {
          setActiveProjectId(null);
          loadProject(tl.edl, 0);
          setActivePeaks(peaks);
        }
      }
    }
    void bootstrap();
    const unsubs = sseUnsubsRef.current;
    return () => {
      cancelled = true;
      for (const close of unsubs.values()) close();
      unsubs.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 300ms debounced EDL auto-save for persisted projects
  useEffect(() => {
    if (!dirty || !edl || !activeProjectId) return;
    const timer = setTimeout(() => {
      void transport
        .saveTimeline(activeProjectId, edl)
        .then(() => markSaved())
        .catch((err) => {
          setStatusMessage(
            `Auto-save warning: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [dirty, edl, activeProjectId, transport, markSaved]);

  // Global Pro NLE Keyboard Shortcuts (Space, J/K/L, I/O, S, Delete, Ctrl+Z / Ctrl+Shift+Z)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }

      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }

      if (activeTab !== "editor") return;
      const store = useTimelineStore.getState();
      if (!store.edl) return;

      if (e.code === "Space") {
        e.preventDefault();
        store.togglePlayback();
      } else if (key === "k") {
        e.preventDefault();
        store.setIsPlaying(false);
        store.setPlaybackRate(1);
      } else if (key === "l") {
        e.preventDefault();
        const nextRate =
          store.isPlaying && store.playbackRate >= 1
            ? Math.min(4, store.playbackRate * 2)
            : 1;
        store.setPlaybackRate(nextRate);
        store.setIsPlaying(true);
      } else if (key === "j") {
        e.preventDefault();
        store.setPlaybackRate(-1.5);
        store.setIsPlaying(true);
      } else if (key === "i") {
        e.preventDefault();
        store.setInPointMs(store.playheadMs);
      } else if (key === "o") {
        e.preventDefault();
        store.setOutPointMs(store.playheadMs);
      } else if (key === "s" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        try {
          if (
            store.inPointMs !== null &&
            store.outPointMs !== null &&
            Math.abs(store.outPointMs - store.inPointMs) >= 150
          ) {
            store.bladeCut(
              Math.min(store.inPointMs, store.outPointMs),
              Math.max(store.inPointMs, store.outPointMs),
            );
          } else {
            const coldMs = getColdOpenDurationMs(store.edl);
            const total = getTotalDurationMs(store.edl);
            const cutS = Math.max(coldMs, store.playheadMs);
            const cutE = Math.min(total, cutS + 1500);
            store.bladeCut(cutS, cutE);
          }
        } catch (err) {
          setStatusMessage(err instanceof Error ? err.message : String(err));
        }
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (store.selectedWordId) {
          e.preventDefault();
          store.removeWord(store.selectedWordId);
        } else if (store.selectedOverlayId) {
          e.preventDefault();
          store.removeOverlay(store.selectedOverlayId);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTab, undo, redo]);

  async function handleOpenProject(projectId: string) {
    try {
      await loadEditorProject(transport, projectId);
      setActiveTab("editor");
    } catch (err) {
      setStatusMessage(
        `Could not open clip: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function handleUpdateProjectStatus(
    projectId: string,
    status: ClipStatus,
  ) {
    try {
      const updated = await transport.updateProjectStatus(projectId, status);
      setProjects((prev) =>
        prev.map((p) => (p.id === updated.id ? updated : p)),
      );
    } catch (err) {
      setStatusMessage(
        `Status update failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function handleExportActiveProject() {
    if (!activeProjectId || !edl) return;
    setExportingNow(true);
    try {
      if (dirty) {
        await transport.saveTimeline(activeProjectId, edl);
        markSaved();
      }
      await transport.exportProject(activeProjectId, {
        ratio: edl.output.ratio,
        quality: edl.output.quality,
        speedPreset: edl.output.speedPreset,
      });
      await refreshWorkspace(transport);
      setActiveTab("exports");
    } catch (err) {
      setStatusMessage(
        `Export failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setExportingNow(false);
    }
  }

  const activeMediaUrl = useMemo(() => {
    if (!activeProjectId) return null;
    const summary = projects.find((p) => p.id === activeProjectId);
    if (!summary?.hasSlice) return null;
    return transport.projectMediaUrl(activeProjectId);
  }, [activeProjectId, projects, transport]);

  const navItems: { id: StudioTab; label: string; icon: typeof LayoutDashboard }[] = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "creators", label: "Creators", icon: Users },
    { id: "editor", label: "Editor", icon: Clapperboard },
    { id: "exports", label: "Exports", icon: Film },
    { id: "settings", label: "Settings", icon: Settings },
  ];

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#0B0D12] text-[#F1F5F9]">
      {/* Top Studio Header */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-[#222836] bg-[#131720] px-4">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[#6366F1] text-white shadow-sm">
              <Sparkles className="h-4 w-4" />
            </div>
            <span className="text-sm font-semibold tracking-tight">CutFlow</span>
            <span className="rounded bg-[#1A202C] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[#94A3B8]">
              Studio v0.1
            </span>
          </div>

          <nav className="flex items-center gap-1" aria-label="Workspace Tabs">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    isActive
                      ? "bg-[#6366F1]/15 text-[#F1F5F9] ring-1 ring-[#6366F1]/40"
                      : "text-[#94A3B8] hover:bg-[#1A202C] hover:text-[#F1F5F9]"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {item.label}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-2">
          {statusMessage && activeTab === "editor" && (
            <span className="max-w-xs truncate rounded border border-[#F59E0B]/40 bg-[#F59E0B]/10 px-2 py-0.5 text-[11px] text-[#FDE68A]">
              {statusMessage}
            </span>
          )}

          {activeTab === "editor" && (
            <div className="mr-2 flex items-center gap-1 border-r border-[#222836] pr-3">
              <button
                type="button"
                onClick={undo}
                disabled={undoStack.length === 0}
                title="Undo (Ctrl+Z)"
                className="rounded p-1.5 text-[#94A3B8] transition-colors hover:bg-[#1A202C] hover:text-white disabled:opacity-35"
              >
                <Undo2 className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={redo}
                disabled={redoStack.length === 0}
                title="Redo (Ctrl+Shift+Z)"
                className="rounded p-1.5 text-[#94A3B8] transition-colors hover:bg-[#1A202C] hover:text-white disabled:opacity-35"
              >
                <Redo2 className="h-3.5 w-3.5" />
              </button>
              {dirty && (
                <span className="ml-1 text-[11px] text-[#F59E0B]">Saving...</span>
              )}
            </div>
          )}

          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${
              transport.mode === "local"
                ? "border-[#10B981]/30 bg-[#10B981]/10 text-[#10B981]"
                : "border-[#38BDF8]/30 bg-[#38BDF8]/10 text-[#38BDF8]"
            }`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {transport.mode === "local"
              ? `Local API (${health?.database ?? "sqlite"})`
              : "Demo Mode"}
          </span>
        </div>
      </header>

      {/* Main Workspace Area */}
      <main className="min-h-0 flex-1 overflow-hidden">
        {activeTab === "dashboard" && (
          <DashboardPage
            transport={transport}
            profiles={profiles}
            selectedProfileId={selectedProfileId}
            onSelectProfileId={setSelectedProfileId}
            sources={sources}
            jobs={jobs}
            projects={projects}
            feedItems={feedItems}
            storage={storage}
            onRefreshAll={async () => {
              await refreshWorkspace(transport);
            }}
            onJobStarted={(job) => {
              setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
              attachJobStream(transport, job.id);
            }}
            onOpenProject={(id) => void handleOpenProject(id)}
          />
        )}

        {activeTab === "creators" && (
          <CreatorsPage
            transport={transport}
            profiles={profiles}
            onCreated={async () => {
              await refreshWorkspace(transport);
            }}
          />
        )}

        {activeTab === "editor" && (
          <EditorStudioPage
            transport={transport}
            projects={projects}
            activeProjectId={activeProjectId}
            mediaUrl={activeMediaUrl}
            peaks={activePeaks}
            exportingNow={exportingNow}
            initialBoundaries={editorBoundaries}
            onSelectProject={(id) => void handleOpenProject(id)}
            onUpdateProjectStatus={handleUpdateProjectStatus}
            onExportNow={handleExportActiveProject}
            onError={setStatusMessage}
          />
        )}

        {activeTab === "exports" && (
          <ExportsPage
            transport={transport}
            projects={projects}
            exportsList={exportsList}
            onOpenProject={(id) => void handleOpenProject(id)}
            onUpdateProjectStatus={handleUpdateProjectStatus}
            onRefresh={async () => {
              await refreshWorkspace(transport);
            }}
          />
        )}

        {activeTab === "settings" && (
          <SettingsPage
            transport={transport}
            keysPresent={keysPresent}
            initialBoundaries={editorBoundaries}
            onRefresh={async () => {
              await refreshWorkspace(transport);
            }}
          />
        )}
      </main>
    </div>
  );
}
