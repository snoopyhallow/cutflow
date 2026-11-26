import { useMemo, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  ArrowCounterClockwise,
  CheckCircle,
  FilmSlate,
  Plus,
  TerminalWindow,
  TextAa,
  Trash,
} from "@phosphor-icons/react";
import { AiCoEditorPanel } from "../components/agent/AiCoEditorPanel";
import { StudioStage } from "../components/canvas/StudioStage";
import { ContextInspector } from "../components/inspector/ContextInspector";
import { MultiTrackTimeline } from "../components/timeline/MultiTrackTimeline";
import { formatTimecodeMs } from "../edl";
import { useTimelineStore } from "../state/timelineStore";
import type {
  BgmAssetItem,
  ClipProjectSummary,
  ClipStatus,
  ProjectPeaks,
  StudioTransport,
} from "../transport";

interface EditorStudioPageProps {
  transport: StudioTransport;
  projects: ClipProjectSummary[];
  bgmAssets: BgmAssetItem[];
  activeProjectId: string | null;
  mediaUrl: string | null;
  filmstripUrl: string | null;
  peaks: ProjectPeaks | null;
  exportingNow: boolean;
  initialBoundaries?: string;
  onSelectProject: (projectId: string) => void;
  onUpdateProjectStatus: (projectId: string, status: ClipStatus) => Promise<void>;
  onRefreshBgm: () => Promise<void>;
  onExportNow: () => Promise<void>;
  onError: (msg: string) => void;
}

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-[#1C1C22] text-[#A1A1AA]",
  approved: "bg-[#22C55E]/15 text-[#4ADE80]",
  exported: "bg-[#F59E0B]/15 text-[#FBBF24]",
  posted: "bg-[#E4E4E7]/15 text-[#F4F4F5]",
  archived: "bg-[#27272A] text-[#71717A]",
};

export function EditorStudioPage({
  transport,
  projects,
  bgmAssets,
  activeProjectId,
  mediaUrl,
  filmstripUrl,
  peaks,
  exportingNow,
  initialBoundaries = "",
  onSelectProject,
  onUpdateProjectStatus,
  onRefreshBgm,
  onExportNow,
  onError,
}: EditorStudioPageProps) {
  const {
    edl,
    playheadMs,
    selectedWordId,
    lastAiPatch,
    setPlayheadMs,
    selectWord,
    addWord,
    removeWord,
    revertLastAiPatch,
  } = useTimelineStore();

  const [leftMode, setLeftMode] = useState<"transcript" | "agent" | "clips">("agent");
  const [newWordText, setNewWordText] = useState("WAIT!");

  const activeBgmUrl = useMemo(() => {
    const assetId = edl?.tracks.audio.bgm?.assetId;
    if (!assetId) return null;
    return transport.bgmMediaUrl(assetId);
  }, [edl?.tracks.audio.bgm?.assetId, transport]);

  if (!edl) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-[#71717A]">
        Loading timeline project...
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[#09090B]">
      {lastAiPatch && (
        <div className="flex items-center justify-between border-b border-[#F59E0B]/30 bg-[#F59E0B]/10 px-4 py-1.5 text-xs text-[#FDE68A]">
          <span>Co-Editor applied: {lastAiPatch.summary.join(" · ")}</span>
          <button
            type="button"
            onClick={revertLastAiPatch}
            className="inline-flex items-center gap-1 rounded border border-[#32323B] bg-[#141418] px-2 py-0.5 text-xs font-medium text-[#F4F4F5] hover:bg-[#202026]"
          >
            <ArrowCounterClockwise className="h-3 w-3" />
            Revert
          </button>
        </div>
      )}

      <PanelGroup direction="vertical" className="min-h-0 flex-1">
        {/* Top Row: Left Studio Bin | Center 60fps Stage | Right 5-Tab Inspector */}
        <Panel defaultSize={62} minSize={35}>
          <PanelGroup direction="horizontal" className="h-full">
            {/* Left Dock */}
            <Panel defaultSize={25} minSize={18}>
              <section className="flex h-full flex-col border-r border-[#222228] bg-[#111114]">
                <div className="grid grid-cols-3 border-b border-[#222228] bg-[#0C0C0F] text-[11px] font-medium">
                  <button
                    type="button"
                    onClick={() => setLeftMode("agent")}
                    className={`flex items-center justify-center gap-1.5 border-b-2 py-2 transition-colors ${
                      leftMode === "agent"
                        ? "border-[#F59E0B] bg-[#111114] text-[#F4F4F5]"
                        : "border-transparent text-[#71717A] hover:text-[#D4D4D8]"
                    }`}
                  >
                    <TerminalWindow className="h-3.5 w-3.5" />
                    Co-Editor
                  </button>
                  <button
                    type="button"
                    onClick={() => setLeftMode("transcript")}
                    className={`flex items-center justify-center gap-1.5 border-b-2 py-2 transition-colors ${
                      leftMode === "transcript"
                        ? "border-[#F59E0B] bg-[#111114] text-[#F4F4F5]"
                        : "border-transparent text-[#71717A] hover:text-[#D4D4D8]"
                    }`}
                  >
                    <TextAa className="h-3.5 w-3.5" />
                    Words
                  </button>
                  <button
                    type="button"
                    onClick={() => setLeftMode("clips")}
                    className={`flex items-center justify-center gap-1.5 border-b-2 py-2 transition-colors ${
                      leftMode === "clips"
                        ? "border-[#F59E0B] bg-[#111114] text-[#F4F4F5]"
                        : "border-transparent text-[#71717A] hover:text-[#D4D4D8]"
                    }`}
                  >
                    <FilmSlate className="h-3.5 w-3.5" />
                    Clips ({projects.length})
                  </button>
                </div>

                {leftMode === "agent" ? (
                  <div className="min-h-0 flex-1">
                    <AiCoEditorPanel
                      transport={transport}
                      projectId={activeProjectId}
                      initialBoundaries={initialBoundaries}
                    />
                  </div>
                ) : leftMode === "transcript" ? (
                  <>
                    <div className="flex items-center gap-1.5 border-b border-[#222228] p-2">
                      <input
                        type="text"
                        value={newWordText}
                        onChange={(e) => setNewWordText(e.target.value)}
                        placeholder="Insert word at playhead..."
                        className="min-w-0 flex-1 rounded border border-[#222228] bg-[#09090B] px-2 py-1 text-xs text-[#F4F4F5] focus:border-[#F59E0B] focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (!newWordText.trim()) return;
                          addWord(newWordText, playheadMs, 650);
                          setNewWordText("");
                        }}
                        className="inline-flex items-center gap-1 rounded bg-[#F59E0B] px-2.5 py-1 text-xs font-semibold text-[#09090B] hover:bg-[#FBBF24]"
                      >
                        <Plus weight="bold" className="h-3 w-3" />
                        Add
                      </button>
                    </div>

                    <div className="flex-1 space-y-1 overflow-y-auto p-2">
                      {edl.tracks.subtitles.words.map((w) => {
                        const isSelected = selectedWordId === w.id;
                        const isPlaying =
                          playheadMs >= w.startMs && playheadMs <= w.endMs;
                        return (
                          <div
                            key={w.id}
                            onClick={() => {
                              selectWord(w.id);
                              setPlayheadMs(w.startMs);
                            }}
                            className={`flex cursor-pointer items-center justify-between rounded border px-2 py-1.5 text-xs transition-colors ${
                              isSelected
                                ? "border-[#F59E0B] bg-[#F59E0B]/12 text-[#F4F4F5]"
                                : isPlaying
                                  ? "border-[#3F3F46] bg-[#1C1C22] text-[#F4F4F5]"
                                  : "border-[#1E1E24] bg-[#09090B]/70 text-[#D4D4D8] hover:border-[#2E2E38]"
                            }`}
                          >
                            <div className="flex min-w-0 items-center gap-1.5">
                              {w.glowColor && (
                                <span
                                  className="h-2 w-2 shrink-0 rounded-full"
                                  style={{ backgroundColor: w.glowColor }}
                                />
                              )}
                              <span className="truncate font-medium">{w.text}</span>
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                              <span className="tabular-tc text-[10px] text-[#71717A]">
                                {formatTimecodeMs(w.startMs)}
                              </span>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  removeWord(w.id);
                                }}
                                aria-label={`Delete ${w.text}`}
                                className="text-[#71717A] hover:text-[#EF4444]"
                              >
                                <Trash className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <div className="flex-1 space-y-1.5 overflow-y-auto p-2">
                    {projects.map((p) => {
                      const active = p.id === activeProjectId;
                      return (
                        <div
                          key={p.id}
                          onClick={() => onSelectProject(p.id)}
                          className={`cursor-pointer rounded-md border p-2.5 text-left text-xs transition-colors ${
                            active
                              ? "border-[#F59E0B] bg-[#18181C] text-[#F4F4F5]"
                              : "border-[#222228] bg-[#09090B]/70 text-[#D4D4D8] hover:border-[#32323B]"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className="tabular-tc text-[10px] font-semibold text-[#F59E0B]">
                              #{p.rank} · {p.score}
                            </span>
                            <span
                              className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${
                                STATUS_BADGE[p.status] ?? STATUS_BADGE.draft
                              }`}
                            >
                              {p.status}
                            </span>
                          </div>
                          <div className="mt-1 line-clamp-2 font-medium">{p.title}</div>
                          <div className="mt-2 flex items-center justify-between">
                            <span className="tabular-tc text-[10px] text-[#71717A]">
                              {formatTimecodeMs(p.totalDurationMs)}
                            </span>
                            {p.status !== "approved" && p.status !== "posted" && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void onUpdateProjectStatus(p.id, "approved");
                                }}
                                className="inline-flex items-center gap-1 rounded border border-[#22C55E]/35 bg-[#22C55E]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#4ADE80] hover:bg-[#22C55E]/20"
                              >
                                <CheckCircle className="h-2.5 w-2.5" />
                                Approve
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </Panel>

            <PanelResizeHandle className="w-px bg-[#222228] transition-colors hover:bg-[#F59E0B]" />

            {/* Center 60fps Single-Video + BGM Stage */}
            <Panel defaultSize={45} minSize={30}>
              <StudioStage mediaUrl={mediaUrl} bgmUrl={activeBgmUrl} peaks={peaks} />
            </Panel>

            <PanelResizeHandle className="w-px bg-[#222228] transition-colors hover:bg-[#F59E0B]" />

            {/* Right 5-Tab Context Inspector */}
            <Panel defaultSize={30} minSize={22}>
              <ContextInspector
                transport={transport}
                bgmAssets={bgmAssets}
                onRefreshBgm={onRefreshBgm}
                canExport={Boolean(activeProjectId)}
                exportingNow={exportingNow}
                onExportNow={onExportNow}
                onError={onError}
                onPinWebcam={async (camBox, splitRatio) => {
                  try {
                    const targetId = activeProjectId ?? edl.projectId;
                    const prof = await transport.pinWebcamToProfile(
                      targetId,
                      camBox,
                      splitRatio,
                    );
                    onError(`Pinned facecam region to "${prof.name}".`);
                  } catch (err) {
                    onError(err instanceof Error ? err.message : String(err));
                  }
                }}
              />
            </Panel>
          </PanelGroup>
        </Panel>

        <PanelResizeHandle className="h-px bg-[#222228] transition-colors hover:bg-[#F59E0B]" />

        {/* Bottom Dock: Filmstrip Multi-Track NLE Timeline + BGM Track + Waveform */}
        <Panel defaultSize={38} minSize={24}>
          <MultiTrackTimeline
            peaks={peaks}
            filmstripUrl={filmstripUrl}
            bgmAssets={bgmAssets}
            onError={onError}
          />
        </Panel>
      </PanelGroup>
    </div>
  );
}
