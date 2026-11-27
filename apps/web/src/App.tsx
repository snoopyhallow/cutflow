import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  CornersOut,
  Export,
  House,
  Minus,
  Scissors,
  Sliders,
  TrayArrowDown,
  UserFocus,
  X,
} from "@phosphor-icons/react";
import { CutFlowLogo } from "./components/ui/BrandIcons";
import { getColdOpenDurationMs, getTotalDurationMs } from "./edl";
import { CreatorsPage } from "./pages/CreatorsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { EditorStudioPage } from "./pages/EditorStudioPage";
import { ExportsPage } from "./pages/ExportsPage";
import { HomeHubPage } from "./pages/HomeHubPage";
import {
  SettingsPage,
  type IngestSettingsState,
  type ModelRoutingState,
} from "./pages/SettingsPage";
import { useTimelineStore } from "./state/timelineStore";
import {
  createTransport,
  DemoTransport,
  getDesktopBridge,
  type BgmAssetItem,
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

type StudioTab =
  | "home"
  | "dashboard"
  | "editor"
  | "creators"
  | "exports"
  | "settings";

const TAB_TITLES: Record<StudioTab, string> = {
  home: "Home Hub",
  dashboard: "Media & Ingest",
  editor: "Cut Room",
  creators: "Creator Profiles",
  exports: "Render Queue",
  settings: "Studio Settings",
};

const DRAG_REGION_STYLE = { WebkitAppRegion: "drag" } as CSSProperties;
const NO_DRAG_STYLE = { WebkitAppRegion: "no-drag" } as CSSProperties;

export default function App() {
  const [activeTab, setActiveTab] = useState<StudioTab>("home");
  const [transport, setTransport] = useState<StudioTransport>(() => createTransport());
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [profiles, setProfiles] = useState<CreatorProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [projects, setProjects] = useState<ClipProjectSummary[]>([]);
  const [bgmAssets, setBgmAssets] = useState<BgmAssetItem[]>([]);
  const [exportsList, setExportsList] = useState<ExportSummary[]>([]);
  const [exportingNow, setExportingNow] = useState(false);
  const [feedItems, setFeedItems] = useState<FeedItem[]>([]);
  const [storage, setStorage] = useState<StorageSummary | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activePeaks, setActivePeaks] = useState<ProjectPeaks | null>(null);
  const [editorBoundaries, setEditorBoundaries] = useState<string>("");
  const [modelRouting, setModelRouting] = useState<ModelRoutingState>({
    active_provider: "gemini",
    scan_model: "gemini-3.5-flash-lite",
    editor_model: "gemini-3.5-flash-lite",
    ollama_url: "http://127.0.0.1:11434",
  });
  const [ingestConfig, setIngestConfig] = useState<IngestSettingsState>({
    cookies_browser: "none",
    concurrent_fragments: 8,
  });
  const [keysPresent, setKeysPresent] = useState<Record<string, boolean>>({});
  const [statusMessage, setStatusMessage] = useState<string>("");
  const sseUnsubsRef = useRef<Map<string, () => void>>(new Map());

  const desktopBridge = getDesktopBridge();

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
      loadedBgm,
      loadedExports,
      loadedFeed,
      loadedStorage,
      loadedSettings,
    ] = await Promise.all([
      activeTransport.listProfiles(),
      activeTransport.listSources(),
      activeTransport.listJobs(),
      activeTransport.listProjects(),
      activeTransport.listBgm().catch(() => [] as BgmAssetItem[]),
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
    setBgmAssets(loadedBgm);
    setExportsList(loadedExports);
    setFeedItems(loadedFeed);
    setStorage(loadedStorage);
    setKeysPresent(loadedSettings.keys_present);
    const modCfg = loadedSettings.settings?.models as
      | {
          active_provider?: ModelRoutingState["active_provider"];
          scan_model?: string;
          editor_model?: string;
          providers?: { ollama?: { base_url?: string } };
        }
      | undefined;
    if (modCfg) {
      setModelRouting({
        active_provider: modCfg.active_provider ?? "gemini",
        scan_model: modCfg.scan_model ?? "gemini-3.5-flash-lite",
        editor_model: modCfg.editor_model ?? "gemini-3.5-flash-lite",
        ollama_url: modCfg.providers?.ollama?.base_url ?? "http://127.0.0.1:11434",
      });
    }
    const ingCfg = loadedSettings.settings?.ingest as
      | { cookies_browser?: string; concurrent_fragments?: number }
      | undefined;
    if (ingCfg) {
      setIngestConfig({
        cookies_browser: ingCfg.cookies_browser ?? "none",
        concurrent_fragments: ingCfg.concurrent_fragments ?? 8,
      });
    }
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
                  downloadDetail: evt.detail ?? j.downloadDetail,
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
        const tl = await fallback.getTimeline("clip_demo_cinema");
        const peaks = await fallback.getProjectPeaks("clip_demo_cinema");
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

  // Global Pro NLE Keyboard Shortcuts (complementing MultiTrackTimeline shortcuts)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
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

      if (key === "i") {
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
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        store.setIsPlaying(false);
        store.setPlayheadMs(store.playheadMs - (e.shiftKey ? 500 : 33));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        store.setIsPlaying(false);
        store.setPlayheadMs(store.playheadMs + (e.shiftKey ? 500 : 33));
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
        `Could not open project: ${err instanceof Error ? err.message : String(err)}`,
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

  async function handleExportProjectById(projectId: string) {
    setExportingNow(true);
    try {
      if (projectId === activeProjectId && dirty && edl) {
        await transport.saveTimeline(projectId, edl);
        markSaved();
      }
      const opts =
        projectId === activeProjectId && edl
          ? {
              ratio: edl.output.ratio,
              quality: edl.output.quality,
              speedPreset: edl.output.speedPreset,
            }
          : undefined;
      await transport.exportProject(projectId, opts);
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

  async function handleExportActiveProject() {
    if (!activeProjectId || !edl) return;
    await handleExportProjectById(activeProjectId);
  }

  const activeMediaUrl = useMemo(() => {
    if (!activeProjectId) return null;
    const summary = projects.find((p) => p.id === activeProjectId);
    const cacheTag =
      transport.mode === "local" && summary?.updatedAt
        ? `?v=${encodeURIComponent(summary.updatedAt)}`
        : "";
    if (summary?.hasSlice) {
      const base = transport.projectMediaUrl(activeProjectId);
      return base ? `${base}${cacheTag}` : null;
    }
    if (transport.mode === "local") {
      const clipSourceId =
        edl?.tracks.video.clips.find((c) => Boolean(c.sourceId))?.sourceId ||
        edl?.sourceId ||
        summary?.sourceId;
      if (clipSourceId) {
        const base =
          transport.sourceMediaUrl(clipSourceId) ??
          transport.projectMediaUrl(activeProjectId);
        return base ? `${base}${cacheTag}` : null;
      }
    }
    return null;
  }, [activeProjectId, projects, edl, transport]);

  const activeFilmstripUrl = useMemo(() => {
    if (!activeProjectId) return null;
    const summary = projects.find((p) => p.id === activeProjectId);
    if (!summary?.hasFilmstrip) return null;
    const base = transport.projectFilmstripUrl(activeProjectId);
    const cacheTag =
      transport.mode === "local" && summary.updatedAt
        ? `?v=${encodeURIComponent(summary.updatedAt)}`
        : "";
    return base ? `${base}${cacheTag}` : null;
  }, [activeProjectId, projects, transport]);

  const runningJobsCount = jobs.filter(
    (j) => j.status === "queued" || j.status === "running",
  ).length;

  const railItems: {
    id: StudioTab;
    label: string;
    icon: typeof TrayArrowDown;
    badge?: number;
  }[] = [
    { id: "home", label: "Home Hub", icon: House },
    {
      id: "dashboard",
      label: "Media & Ingest",
      icon: TrayArrowDown,
      badge: runningJobsCount > 0 ? runningJobsCount : undefined,
    },
    { id: "editor", label: "Cut Room", icon: Scissors },
    { id: "creators", label: "Creator Profiles", icon: UserFocus },
    {
      id: "exports",
      label: "Render Queue",
      icon: Export,
      badge: exportsList.length > 0 ? exportsList.length : undefined,
    },
    { id: "settings", label: "Studio Settings", icon: Sliders },
  ];

  return (
    <div className="flex h-screen select-none overflow-hidden bg-[#09090B] text-[#F4F4F5]">
      {/* Desktop Studio Left Icon Rail */}
      <aside
        aria-label="Primary Navigation"
        className="flex w-[54px] shrink-0 flex-col items-center justify-between border-r border-[#222228] bg-[#0C0C0F] py-2.5"
      >
        <div className="flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={() => setActiveTab("home")}
            title="CutFlow Home Hub"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#282830] bg-[#141418] text-[#F4F4F5] transition-colors hover:border-[#F59E0B]/60"
          >
            <CutFlowLogo className="h-5 w-5" />
          </button>

          <div className="h-px w-6 bg-[#222228]" />

          <nav className="flex flex-col items-center gap-1.5" aria-label="Workspace Views">
            {railItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  title={item.label}
                  aria-label={item.label}
                  onClick={() => setActiveTab(item.id)}
                  className={`group relative flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
                    isActive
                      ? "bg-[#1C1C22] text-[#F4F4F5]"
                      : "text-[#71717A] hover:bg-[#151519] hover:text-[#D4D4D8]"
                  }`}
                >
                  {isActive && (
                    <span className="absolute -left-[9px] h-5 w-[2.5px] rounded-r bg-[#F59E0B]" />
                  )}
                  <Icon
                    weight={isActive ? "fill" : "regular"}
                    className="h-[18px] w-[18px]"
                  />
                  {item.badge !== undefined && (
                    <span className="tabular-tc absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-[#F59E0B] px-1 text-[9px] font-bold text-[#09090B]">
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="flex flex-col items-center gap-2 pb-1">
          <span
            title={
              transport.mode === "local"
                ? `Connected to Local API (${health?.database ?? "sqlite"})`
                : "Running in Browser Demo Mode"
            }
            className="flex h-6 w-6 items-center justify-center rounded border border-[#222228] bg-[#111114]"
          >
            <span
              className={`h-2 w-2 rounded-full ${
                transport.mode === "local" ? "bg-[#22C55E]" : "bg-[#F59E0B]"
              }`}
            />
          </span>
        </div>
      </aside>

      {/* Right Studio Column: Slim Context Topbar + Active Workspace */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header
          style={desktopBridge ? DRAG_REGION_STYLE : undefined}
          className="flex h-10 shrink-0 items-center justify-between border-b border-[#222228] bg-[#0E0E11] pl-4 pr-2"
        >
          <div className="flex min-w-0 items-center gap-2 text-xs">
            <span className="font-semibold tracking-tight text-[#F4F4F5]">CutFlow</span>
            <span className="text-[#3F3F46]">/</span>
            <span className="font-medium text-[#A1A1AA]">{TAB_TITLES[activeTab]}</span>
            {activeTab === "editor" && edl && (
              <>
                <span className="text-[#3F3F46]">/</span>
                <span className="max-w-[260px] truncate font-medium text-[#F4F4F5]">
                  {edl.title}
                </span>
                <span className="tabular-tc rounded border border-[#27272F] bg-[#16161B] px-1.5 py-0.5 text-[10px] text-[#A1A1AA]">
                  {edl.output.ratio} · {edl.output.quality}
                </span>
              </>
            )}
          </div>

          <div
            style={desktopBridge ? NO_DRAG_STYLE : undefined}
            className="flex items-center gap-2"
          >
            {statusMessage && (
              <button
                type="button"
                onClick={() => setStatusMessage("")}
                title="Click to dismiss"
                className="max-w-xs truncate rounded border border-[#F59E0B]/40 bg-[#F59E0B]/10 px-2 py-0.5 text-[11px] text-[#FDE68A]"
              >
                {statusMessage}
              </button>
            )}

            {activeTab === "editor" && (
              <div className="flex items-center gap-1 border-r border-[#222228] pr-2.5">
                <button
                  type="button"
                  onClick={undo}
                  disabled={undoStack.length === 0}
                  title="Undo (Ctrl+Z)"
                  className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-[#A1A1AA] transition-colors hover:bg-[#18181C] hover:text-[#F4F4F5] disabled:opacity-30"
                >
                  <ArrowCounterClockwise className="h-3.5 w-3.5" />
                  {undoStack.length > 0 && (
                    <span className="tabular-tc text-[10px]">{undoStack.length}</span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={redo}
                  disabled={redoStack.length === 0}
                  title="Redo (Ctrl+Shift+Z)"
                  className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-[#A1A1AA] transition-colors hover:bg-[#18181C] hover:text-[#F4F4F5] disabled:opacity-30"
                >
                  <ArrowClockwise className="h-3.5 w-3.5" />
                  {redoStack.length > 0 && (
                    <span className="tabular-tc text-[10px]">{redoStack.length}</span>
                  )}
                </button>
                {dirty && (
                  <span className="tabular-tc ml-1 text-[10px] text-[#F59E0B]">Saving</span>
                )}
              </div>
            )}

            <span className="tabular-tc inline-flex items-center gap-1.5 rounded border border-[#222228] bg-[#141418] px-2 py-0.5 text-[10px] font-medium text-[#A1A1AA]">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  transport.mode === "local" ? "bg-[#22C55E]" : "bg-[#F59E0B]"
                }`}
              />
              {desktopBridge
                ? "DESKTOP · NATIVE"
                : transport.mode === "local"
                  ? `LOCAL · ${(health?.database ?? "sqlite").toUpperCase()}`
                  : "DEMO STUDIO"}
            </span>

            {desktopBridge && (
              <div className="ml-1 flex items-center border-l border-[#222228] pl-1">
                <button
                  type="button"
                  aria-label="Minimize window"
                  onClick={() => desktopBridge.minimizeWindow?.()}
                  className="flex h-7 w-8 items-center justify-center rounded text-[#A1A1AA] hover:bg-[#1C1C22] hover:text-white"
                >
                  <Minus className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="Maximize window"
                  onClick={() => desktopBridge.toggleMaximizeWindow?.()}
                  className="flex h-7 w-8 items-center justify-center rounded text-[#A1A1AA] hover:bg-[#1C1C22] hover:text-white"
                >
                  <CornersOut className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="Close window"
                  onClick={() => desktopBridge.closeWindow?.()}
                  className="flex h-7 w-8 items-center justify-center rounded text-[#A1A1AA] hover:bg-[#EF4444] hover:text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-hidden">
          {activeTab === "home" && (
            <HomeHubPage
              transport={transport}
              projects={projects}
              activeProjectId={activeProjectId}
              selectedProfileId={selectedProfileId}
              storage={storage}
              activeProvider={modelRouting.active_provider}
              editorModel={modelRouting.editor_model}
              runningJobsCount={runningJobsCount}
              onOpenProject={(id) => void handleOpenProject(id)}
              onNavigateTab={(tab) => setActiveTab(tab)}
              onProjectCreated={async (projectId) => {
                await refreshWorkspace(transport);
                await handleOpenProject(projectId);
              }}
              onRefreshAll={async () => {
                await refreshWorkspace(transport);
              }}
              onExportProject={handleExportProjectById}
              onStatusMessage={setStatusMessage}
            />
          )}

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
              bgmAssets={bgmAssets}
              onCreated={async () => {
                await refreshWorkspace(transport);
              }}
            />
          )}

          {activeTab === "editor" && (
            <EditorStudioPage
              transport={transport}
              sources={sources}
              projects={projects}
              bgmAssets={bgmAssets}
              activeProjectId={activeProjectId}
              mediaUrl={activeMediaUrl}
              filmstripUrl={activeFilmstripUrl}
              peaks={activePeaks}
              exportingNow={exportingNow}
              initialBoundaries={editorBoundaries}
              onSelectProject={(id) => void handleOpenProject(id)}
              onUpdateProjectStatus={handleUpdateProjectStatus}
              onRefreshWorkspace={async () => {
                await refreshWorkspace(transport);
              }}
              onRefreshBgm={async () => {
                const updated = await transport.listBgm();
                setBgmAssets(updated);
              }}
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
              initialModels={modelRouting}
              initialIngest={ingestConfig}
              initialBoundaries={editorBoundaries}
              onRefresh={async () => {
                await refreshWorkspace(transport);
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}
