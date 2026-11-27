import { useMemo, useRef, useState } from "react";
import {
  CheckCircle,
  CircleNotch,
  Copy,
  Export,
  FilmSlate,
  FolderOpen,
  HardDrives,
  MagicWand,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Scissors,
  Sliders,
  Sparkle,
  Subtitles,
  Trash,
  TrayArrowDown,
  UserFocus,
} from "@phosphor-icons/react";
import {
  StudioContextMenu,
  type StudioContextMenuState,
} from "../components/ui/StudioContextMenu";
import { formatTimecodeMs } from "../edl";
import {
  getDesktopBridge,
  type ClipProjectSummary,
  type ClipStatus,
  type StorageSummary,
  type StudioTransport,
} from "../transport";

interface HomeHubPageProps {
  transport: StudioTransport;
  projects: ClipProjectSummary[];
  activeProjectId: string | null;
  selectedProfileId: string;
  storage: StorageSummary | null;
  activeProvider: string;
  editorModel: string;
  runningJobsCount: number;
  onOpenProject: (projectId: string) => Promise<void> | void;
  onNavigateTab: (
    tab: "dashboard" | "editor" | "creators" | "exports" | "settings",
  ) => void;
  onProjectCreated: (projectId: string) => Promise<void>;
  onRefreshAll: () => Promise<void>;
  onExportProject: (projectId: string) => Promise<void>;
  onStatusMessage: (msg: string) => void;
}

const RATIOS: ("9:16" | "16:9" | "1:1" | "4:5")[] = ["9:16", "16:9", "1:1", "4:5"];

const STATUS_STYLE: Record<string, string> = {
  draft: "border-[#2D2D36] bg-[#16161B] text-[#A1A1AA]",
  approved: "border-[#22C55E]/35 bg-[#22C55E]/12 text-[#4ADE80]",
  exported: "border-[#F59E0B]/35 bg-[#F59E0B]/12 text-[#FBBF24]",
  posted: "border-[#38BDF8]/35 bg-[#38BDF8]/12 text-[#7DD3FC]",
  archived: "border-[#27272A] bg-[#18181B] text-[#71717A]",
};

function formatFreeDisk(bytes?: number): string | null {
  if (!bytes || bytes <= 0) return null;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB free`;
}

export function HomeHubPage({
  transport,
  projects,
  activeProjectId,
  selectedProfileId,
  storage,
  activeProvider,
  editorModel,
  runningJobsCount,
  onOpenProject,
  onNavigateTab,
  onProjectCreated,
  onRefreshAll,
  onExportProject,
  onStatusMessage,
}: HomeHubPageProps) {
  const [selectedRatio, setSelectedRatio] = useState<"9:16" | "16:9" | "1:1" | "4:5">(
    "9:16",
  );
  const [creatingBlank, setCreatingBlank] = useState(false);
  const [importingLocal, setImportingLocal] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | ClipStatus>("all");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [contextMenu, setContextMenu] = useState<StudioContextMenuState | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const desktopBridge = getDesktopBridge();

  const filteredProjects = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return projects.filter((p) => {
      if (statusFilter !== "all" && p.status !== statusFilter) return false;
      if (!q) return true;
      return (
        p.title.toLowerCase().includes(q) ||
        p.reason.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q)
      );
    });
  }, [projects, searchQuery, statusFilter]);

  async function handleCreateBlank(localPath?: string) {
    setCreatingBlank(true);
    try {
      const created = await transport.createBlankProject({
        title: localPath
          ? localPath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "Untitled Project"
          : `Untitled ${selectedRatio} Project`,
        ratio: selectedRatio,
        localPath,
        profileId: selectedProfileId || undefined,
      });
      await onProjectCreated(created.id);
    } catch (err) {
      onStatusMessage(
        `Could not create project: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setCreatingBlank(false);
    }
  }

  async function handleQuickOpenLocalMedia() {
    if (desktopBridge?.openMediaDialog) {
      setImportingLocal(true);
      try {
        const paths = await desktopBridge.openMediaDialog({ multiple: false });
        if (paths.length > 0) {
          await handleCreateBlank(paths[0]);
        }
      } catch (err) {
        onStatusMessage(
          `Could not open local media: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setImportingLocal(false);
      }
      return;
    }
    fileInputRef.current?.click();
  }

  async function handleBrowserFilePicked(file: File) {
    setImportingLocal(true);
    try {
      const res = await transport.uploadVideo(file, selectedProfileId || undefined);
      const created = await transport.createBlankProject({
        title: file.name.replace(/\.[^.]+$/, "") || "Imported Video",
        ratio: selectedRatio,
        sourceId: res.source.id,
        profileId: selectedProfileId || undefined,
      });
      await onProjectCreated(created.id);
    } catch (err) {
      onStatusMessage(
        `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setImportingLocal(false);
    }
  }

  async function commitRename(projectId: string) {
    const trimmed = renameDraft.trim();
    setRenamingId(null);
    if (!trimmed) return;
    try {
      await transport.renameProject(projectId, { title: trimmed });
      await onRefreshAll();
    } catch (err) {
      onStatusMessage(
        `Rename failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function handleDuplicate(projectId: string) {
    try {
      const dup = await transport.duplicateProject(projectId);
      await onRefreshAll();
      onStatusMessage(`Duplicated "${dup.title}".`);
    } catch (err) {
      onStatusMessage(
        `Duplicate failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function handleDelete(project: ClipProjectSummary) {
    try {
      await transport.deleteProject(project.id);
      await onRefreshAll();
      onStatusMessage(`Deleted "${project.title}".`);
    } catch (err) {
      onStatusMessage(
        `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function handleAutoCaptionFromHub(project: ClipProjectSummary) {
    try {
      onStatusMessage(`Transcribing "${project.title}"...`);
      const res = await transport.transcribeProject(project.id);
      await onRefreshAll();
      onStatusMessage(
        `Generated ${res.wordCount} captions (${res.provider}) for "${project.title}".`,
      );
    } catch (err) {
      onStatusMessage(
        `Auto-captions failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  function openProjectContextMenu(
    e: React.MouseEvent,
    project: ClipProjectSummary,
  ) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      header: project.title,
      items: [
        {
          id: "open",
          label: "Open in Cut Room",
          shortcut: "Enter",
          icon: <Scissors className="h-3.5 w-3.5" />,
          onSelect: () => void onOpenProject(project.id),
        },
        {
          id: "rename",
          label: "Rename Project",
          shortcut: "F2",
          icon: <PencilSimple className="h-3.5 w-3.5" />,
          onSelect: () => {
            setRenamingId(project.id);
            setRenameDraft(project.title);
          },
        },
        {
          id: "duplicate",
          label: "Duplicate Project",
          shortcut: "Ctrl+D",
          icon: <Copy className="h-3.5 w-3.5" />,
          onSelect: () => void handleDuplicate(project.id),
        },
        {
          id: "autocaptions",
          label: "Generate Auto-Captions",
          icon: <Subtitles className="h-3.5 w-3.5 text-[#F59E0B]" />,
          onSelect: () => void handleAutoCaptionFromHub(project),
        },
        {
          id: "approve",
          label: "Mark Approved",
          icon: <CheckCircle className="h-3.5 w-3.5 text-[#4ADE80]" />,
          disabled: project.status === "approved",
          onSelect: () => {
            void transport
              .updateProjectStatus(project.id, "approved")
              .then(() => onRefreshAll());
          },
        },
        { divider: true },
        {
          id: "export",
          label: "Render MP4...",
          icon: <Export className="h-3.5 w-3.5" />,
          onSelect: () => void onExportProject(project.id),
        },
        { divider: true },
        {
          id: "delete",
          label: "Delete Project",
          shortcut: "Del",
          tone: "danger",
          icon: <Trash className="h-3.5 w-3.5" />,
          onSelect: () => void handleDelete(project),
        },
      ],
    });
  }

  const freeDiskLabel = formatFreeDisk(storage?.diskFreeBytes);

  return (
    <div className="h-full overflow-y-auto bg-[#09090B] px-6 py-6">
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*,audio/*"
        className="hidden"
        onChange={(e) => {
          const picked = e.target.files?.[0];
          if (picked) void handleBrowserFilePicked(picked);
          e.target.value = "";
        }}
      />

      <div className="mx-auto max-w-6xl space-y-6">
        {/* Top Studio Banner & Quick Utility Strip */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold tracking-tight text-[#F4F4F5]">
              CutFlow Studio
            </h1>
            <p className="text-xs text-[#A1A1AA]">
              Multi-track Desktop NLE, AI Co-Editor &amp; Automated Highlight Pipeline
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              onClick={() => onNavigateTab("creators")}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#24242C] bg-[#121216] px-2.5 py-1.5 text-[#D4D4D8] transition-colors hover:border-[#3A3A46] hover:text-white"
            >
              <UserFocus className="h-3.5 w-3.5 text-[#F59E0B]" />
              Creator Profiles
            </button>
            <button
              type="button"
              onClick={() => onNavigateTab("exports")}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#24242C] bg-[#121216] px-2.5 py-1.5 text-[#D4D4D8] transition-colors hover:border-[#3A3A46] hover:text-white"
            >
              <Export className="h-3.5 w-3.5 text-[#4ADE80]" />
              Render Queue
            </button>
            <button
              type="button"
              onClick={() => onNavigateTab("settings")}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#24242C] bg-[#121216] px-2.5 py-1.5 text-[#D4D4D8] transition-colors hover:border-[#3A3A46] hover:text-white"
            >
              <Sliders className="h-3.5 w-3.5 text-[#38BDF8]" />
              AI: {activeProvider} · {editorModel}
            </button>
            {freeDiskLabel && (
              <span className="tabular-tc inline-flex items-center gap-1.5 rounded-md border border-[#222228] bg-[#0E0E12] px-2.5 py-1.5 text-[11px] text-[#71717A]">
                <HardDrives className="h-3.5 w-3.5" />
                {freeDiskLabel}
              </span>
            )}
          </div>
        </div>

        {/* CapCut Desktop-Style Dual Hero Creation Cards */}
        <div className="grid gap-4 md:grid-cols-2">
          {/* Card 1: + New Blank Timeline Project */}
          <div className="flex flex-col justify-between rounded-xl border border-[#F59E0B]/35 bg-gradient-to-br from-[#1A1610] via-[#121216] to-[#0E0E12] p-5 shadow-lg">
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#F59E0B] text-[#09090B] shadow-md">
                  {creatingBlank ? (
                    <CircleNotch className="h-6 w-6 animate-spin" />
                  ) : (
                    <Plus weight="bold" className="h-6 w-6" />
                  )}
                </div>

                <div className="flex items-center gap-1 rounded-lg border border-[#282832] bg-[#0B0B0E] p-1">
                  {RATIOS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setSelectedRatio(r)}
                      className={`tabular-tc rounded px-2 py-0.5 text-[11px] font-semibold transition-colors ${
                        selectedRatio === r
                          ? "bg-[#F59E0B] text-[#09090B]"
                          : "text-[#A1A1AA] hover:text-white"
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <h2 className="text-base font-bold text-[#F4F4F5]">
                  New Blank Project
                </h2>
                <p className="mt-0.5 text-xs leading-relaxed text-[#A1A1AA]">
                  Jump straight into the 7-track Cut Room. Drop local MP4/MKV/MOV clips with
                  zero-copy speed, layer B-Roll &amp; SFX, generate offline Whisper captions,
                  and co-edit with AI.
                </p>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={creatingBlank || importingLocal}
                onClick={() => void handleCreateBlank()}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#F59E0B] px-4 py-2 text-xs font-bold text-[#09090B] transition-colors hover:bg-[#FBBF24] disabled:opacity-45"
              >
                <Plus weight="bold" className="h-4 w-4" />
                Create {selectedRatio} Project
              </button>

              <button
                type="button"
                disabled={creatingBlank || importingLocal}
                onClick={() => void handleQuickOpenLocalMedia()}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#32323D] bg-[#16161C] px-3.5 py-2 text-xs font-semibold text-[#F4F4F5] transition-colors hover:border-[#F59E0B]/60 hover:bg-[#1C1C24] disabled:opacity-45"
              >
                {importingLocal ? (
                  <CircleNotch className="h-4 w-4 animate-spin text-[#F59E0B]" />
                ) : (
                  <FolderOpen className="h-4 w-4 text-[#F59E0B]" />
                )}
                {desktopBridge ? "Open Local Video..." : "Import Video File..."}
              </button>
            </div>
          </div>

          {/* Card 2: AI Auto-Clip VOD / Stream / Movie */}
          <div className="flex flex-col justify-between rounded-xl border border-[#272732] bg-gradient-to-br from-[#121622] via-[#121216] to-[#0E0E12] p-5 shadow-lg">
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#38BDF8]/35 bg-[#38BDF8]/15 text-[#38BDF8]">
                  <MagicWand weight="fill" className="h-6 w-6" />
                </div>

                {runningJobsCount > 0 && (
                  <span className="tabular-tc inline-flex items-center gap-1.5 rounded-full border border-[#F59E0B]/40 bg-[#F59E0B]/15 px-2.5 py-0.5 text-[11px] font-semibold text-[#FBBF24]">
                    <CircleNotch className="h-3 w-3 animate-spin" />
                    {runningJobsCount} active {runningJobsCount === 1 ? "job" : "jobs"}
                  </span>
                )}
              </div>

              <div>
                <h2 className="text-base font-bold text-[#F4F4F5]">
                  AI Auto-Clip VOD / Movie
                </h2>
                <p className="mt-0.5 text-xs leading-relaxed text-[#A1A1AA]">
                  Paste a YouTube, Twitch, or Kick stream URL—or drop a multi-hour recording—to
                  automatically score hype peaks, frame speakers, and build ranked vertical shorts.
                </p>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => onNavigateTab("dashboard")}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[#38BDF8]/45 bg-[#38BDF8]/15 px-4 py-2 text-xs font-bold text-[#E0F2FE] transition-colors hover:bg-[#38BDF8]/25"
              >
                <TrayArrowDown weight="bold" className="h-4 w-4 text-[#38BDF8]" />
                Open Media &amp; Auto-Clip Ingest
              </button>
              {activeProjectId && (
                <button
                  type="button"
                  onClick={() => onNavigateTab("editor")}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#2C2C36] bg-[#16161C] px-3.5 py-2 text-xs font-semibold text-[#D4D4D8] transition-colors hover:border-[#52525B] hover:text-white"
                >
                  <Sparkle className="h-4 w-4 text-[#F59E0B]" />
                  Resume Cut Room
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Recent Projects Section */}
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <FilmSlate className="h-4 w-4 text-[#F59E0B]" />
              <h2 className="text-sm font-semibold text-[#F4F4F5]">
                Recent Projects ({filteredProjects.length})
              </h2>
              <span className="text-[11px] text-[#71717A]">
                Right-click any project for quick actions
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <MagnifyingGlass className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#71717A]" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search projects..."
                  className="w-48 rounded-md border border-[#24242C] bg-[#111115] py-1 pl-8 pr-2.5 text-xs text-[#F4F4F5] placeholder-[#71717A] focus:border-[#F59E0B] focus:outline-none"
                />
              </div>

              <div className="flex items-center gap-1 rounded-md border border-[#24242C] bg-[#111115] p-0.5 text-[11px]">
                {(["all", "draft", "approved", "exported"] as const).map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setStatusFilter(st)}
                    className={`rounded px-2 py-0.5 font-medium capitalize transition-colors ${
                      statusFilter === st
                        ? "bg-[#22222A] text-[#F4F4F5]"
                        : "text-[#71717A] hover:text-[#D4D4D8]"
                    }`}
                  >
                    {st}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {filteredProjects.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[#272730] bg-[#0E0E12] py-12 text-center">
              <FilmSlate className="h-8 w-8 text-[#52525B]" />
              <p className="mt-2 text-xs font-medium text-[#D4D4D8]">
                No projects match this filter yet
              </p>
              <p className="mt-1 text-[11px] text-[#71717A]">
                Click &ldquo;Create {selectedRatio} Project&rdquo; above or import a local video to start editing.
              </p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filteredProjects.map((proj) => {
                const thumbUrl = proj.hasThumb
                  ? transport.projectThumbUrl(proj.id)
                  : null;
                const isCurrent = proj.id === activeProjectId;
                const isRenaming = renamingId === proj.id;

                return (
                  <div
                    key={proj.id}
                    onClick={() => {
                      if (!isRenaming) void onOpenProject(proj.id);
                    }}
                    onContextMenu={(e) => openProjectContextMenu(e, proj)}
                    className={`group flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-[#111115] transition-all hover:border-[#F59E0B]/60 hover:bg-[#15151B] ${
                      isCurrent
                        ? "border-[#F59E0B] ring-1 ring-[#F59E0B]/30"
                        : "border-[#22222A]"
                    }`}
                  >
                    {/* Thumbnail Preview */}
                    <div className="relative aspect-video w-full overflow-hidden bg-[#09090B]">
                      {thumbUrl ? (
                        <img
                          src={thumbUrl}
                          alt={proj.title}
                          loading="lazy"
                          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                        />
                      ) : (
                        <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-gradient-to-br from-[#16161D] to-[#0B0B0E] text-[#52525B]">
                          <Scissors className="h-6 w-6 text-[#71717A]" />
                          <span className="tabular-tc text-[10px] uppercase tracking-wider text-[#71717A]">
                            Timeline Project
                          </span>
                        </div>
                      )}

                      <div className="absolute left-2 top-2 flex items-center gap-1">
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase backdrop-blur-sm ${
                            STATUS_STYLE[proj.status] ?? STATUS_STYLE.draft
                          }`}
                        >
                          {proj.status}
                        </span>
                        {proj.score > 0 && (
                          <span className="tabular-tc rounded bg-black/75 px-1.5 py-0.5 text-[9px] font-semibold text-[#F59E0B]">
                            ★ {proj.score}
                          </span>
                        )}
                      </div>

                      <span className="tabular-tc absolute bottom-2 right-2 rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-semibold text-[#F4F4F5]">
                        {formatTimecodeMs(proj.totalDurationMs)}
                      </span>
                    </div>

                    {/* Metadata Footer */}
                    <div className="flex flex-1 flex-col justify-between p-3">
                      {isRenaming ? (
                        <input
                          type="text"
                          autoFocus
                          value={renameDraft}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onBlur={() => void commitRename(proj.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void commitRename(proj.id);
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                          className="w-full rounded border border-[#F59E0B] bg-[#09090B] px-2 py-1 text-xs font-semibold text-[#F4F4F5] focus:outline-none"
                        />
                      ) : (
                        <h3 className="line-clamp-1 text-xs font-semibold text-[#F4F4F5] group-hover:text-[#FBBF24]">
                          {proj.title}
                        </h3>
                      )}

                      <div className="mt-2 flex items-center justify-between text-[10px] text-[#71717A]">
                        <span className="inline-flex items-center gap-1">
                          <Subtitles className="h-3 w-3" />
                          {proj.wordCount > 0
                            ? `${proj.wordCount} words`
                            : "No captions"}
                        </span>
                        <span className="tabular-tc">
                          {new Date(proj.updatedAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <StudioContextMenu
        menu={contextMenu}
        onClose={() => setContextMenu(null)}
      />
    </div>
  );
}
