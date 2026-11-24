import { useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  Bot,
  CheckCircle2,
  FileText,
  Film,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { AiCoEditorPanel } from "../components/agent/AiCoEditorPanel";
import { StudioStage } from "../components/canvas/StudioStage";
import { ContextInspector } from "../components/inspector/ContextInspector";
import { MultiTrackTimeline } from "../components/timeline/MultiTrackTimeline";
import { formatTimecodeMs } from "../edl";
import { useTimelineStore } from "../state/timelineStore";
import type {
  ClipProjectSummary,
  ClipStatus,
  ProjectPeaks,
  StudioTransport,
} from "../transport";

interface EditorStudioPageProps {
  transport: StudioTransport;
  projects: ClipProjectSummary[];
  activeProjectId: string | null;
  mediaUrl: string | null;
  peaks: ProjectPeaks | null;
  exportingNow: boolean;
  initialBoundaries?: string;
  onSelectProject: (projectId: string) => void;
  onUpdateProjectStatus: (projectId: string, status: ClipStatus) => Promise<void>;
  onExportNow: () => Promise<void>;
  onError: (msg: string) => void;
}

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-[#1A202C] text-[#94A3B8]",
  approved: "bg-[#10B981]/20 text-[#34D399]",
  exported: "bg-[#6366F1]/25 text-[#A5B4FC]",
  posted: "bg-[#38BDF8]/20 text-[#7DD3FC]",
  archived: "bg-[#334155]/40 text-[#64748B]",
};

export function EditorStudioPage({
  transport,
  projects,
  activeProjectId,
  mediaUrl,
  peaks,
  exportingNow,
  initialBoundaries = "",
  onSelectProject,
  onUpdateProjectStatus,
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
  const [newWordText, setNewWordText] = useState("SIU!");

  if (!edl) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-[#94A3B8]">
        Loading EDL timeline...
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {lastAiPatch && (
        <div className="flex items-center justify-between border-b border-[#6366F1]/30 bg-[#6366F1]/10 px-4 py-1.5 text-xs">
          <span>AI Co-Editor applied: {lastAiPatch.summary.join(" · ")}</span>
          <button
            type="button"
            onClick={revertLastAiPatch}
            className="inline-flex items-center gap-1 rounded bg-[#1A202C] px-2 py-0.5 text-xs font-medium text-white hover:bg-[#2E374A]"
          >
            <RotateCcw className="h-3 w-3" />
            Revert
          </button>
        </div>
      )}

      <PanelGroup direction="vertical" className="min-h-0 flex-1">
        {/* Top Row: Left Bin/Agent/Transcript | Center 60fps Canvas | Right Context Inspector */}
        <Panel defaultSize={63} minSize={35}>
          <PanelGroup direction="horizontal" className="h-full">
            {/* Left Dock */}
            <Panel defaultSize={26} minSize={18}>
              <section className="flex h-full flex-col border-r border-[#222836] bg-[#131720]">
                <div className="grid grid-cols-3 border-b border-[#222836] bg-[#0F131B] text-[11px] font-medium">
                  <button
                    type="button"
                    onClick={() => setLeftMode("agent")}
                    className={`flex items-center justify-center gap-1 border-b-2 py-2 ${
                      leftMode === "agent"
                        ? "border-[#6366F1] bg-[#131720] text-white"
                        : "border-transparent text-[#94A3B8] hover:text-white"
                    }`}
                  >
                    <Bot className="h-3 w-3" />
                    AI
                  </button>
                  <button
                    type="button"
                    onClick={() => setLeftMode("transcript")}
                    className={`flex items-center justify-center gap-1 border-b-2 py-2 ${
                      leftMode === "transcript"
                        ? "border-[#F59E0B] bg-[#131720] text-white"
                        : "border-transparent text-[#94A3B8] hover:text-white"
                    }`}
                  >
                    <FileText className="h-3 w-3" />
                    Words
                  </button>
                  <button
                    type="button"
                    onClick={() => setLeftMode("clips")}
                    className={`flex items-center justify-center gap-1 border-b-2 py-2 ${
                      leftMode === "clips"
                        ? "border-[#10B981] bg-[#131720] text-white"
                        : "border-transparent text-[#94A3B8] hover:text-white"
                    }`}
                  >
                    <Film className="h-3 w-3" />
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
                    <div className="flex items-center gap-1.5 border-b border-[#222836] p-2">
                      <input
                        type="text"
                        value={newWordText}
                        onChange={(e) => setNewWordText(e.target.value)}
                        placeholder="Add word at playhead..."
                        className="min-w-0 flex-1 rounded border border-[#222836] bg-[#0B0D12] px-2 py-1 text-xs text-white focus:border-[#6366F1] focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (!newWordText.trim()) return;
                          addWord(newWordText, playheadMs, 650);
                          setNewWordText("");
                        }}
                        className="inline-flex items-center gap-1 rounded bg-[#6366F1] px-2 py-1 text-xs font-medium text-white hover:bg-[#5558E6]"
                      >
                        <Plus className="h-3 w-3" />
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
                                ? "border-[#F59E0B] bg-[#F59E0B]/15 text-white"
                                : isPlaying
                                  ? "border-[#6366F1]/50 bg-[#6366F1]/10 text-white"
                                  : "border-[#222836] bg-[#0B0D12]/60 text-[#CBD5E1] hover:border-[#2E374A]"
                            }`}
                          >
                            <span className="truncate font-medium">{w.text}</span>
                            <div className="flex shrink-0 items-center gap-1.5">
                              <span className="tabular-tc text-[10px] text-[#94A3B8]">
                                {formatTimecodeMs(w.startMs)}
                              </span>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  removeWord(w.id);
                                }}
                                aria-label={`Delete ${w.text}`}
                                className="text-[#64748B] hover:text-[#F43F5E]"
                              >
                                <Trash2 className="h-3 w-3" />
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
                          className={`cursor-pointer rounded-lg border p-2 text-left text-xs transition-colors ${
                            active
                              ? "border-[#6366F1] bg-[#6366F1]/15 text-white"
                              : "border-[#222836] bg-[#0B0D12]/60 text-[#CBD5E1] hover:border-[#2E374A]"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className="tabular-tc text-[10px] font-semibold text-[#10B981]">
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
                            <span className="tabular-tc text-[10px] text-[#64748B]">
                              {formatTimecodeMs(p.totalDurationMs)}
                            </span>
                            {p.status !== "approved" && p.status !== "posted" && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void onUpdateProjectStatus(p.id, "approved");
                                }}
                                className="inline-flex items-center gap-1 rounded border border-[#10B981]/40 bg-[#10B981]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#34D399] hover:bg-[#10B981]/20"
                              >
                                <CheckCircle2 className="h-2.5 w-2.5" />
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

            <PanelResizeHandle className="w-1 bg-[#222836] transition-colors hover:bg-[#6366F1]" />

            {/* Center 60fps Single-Video to Canvas Stage */}
            <Panel defaultSize={46} minSize={30}>
              <StudioStage mediaUrl={mediaUrl} />
            </Panel>

            <PanelResizeHandle className="w-1 bg-[#222836] transition-colors hover:bg-[#6366F1]" />

            {/* Right Context-Sensitive Inspector */}
            <Panel defaultSize={28} minSize={20}>
              <ContextInspector
                canExport={Boolean(activeProjectId)}
                exportingNow={exportingNow}
                onExportNow={onExportNow}
              />
            </Panel>
          </PanelGroup>
        </Panel>

        <PanelResizeHandle className="h-1 bg-[#222836] transition-colors hover:bg-[#6366F1]" />

        {/* Bottom Dock: 60fps Multi-Track NLE Timeline + 100Hz Waveform */}
        <Panel defaultSize={37} minSize={24}>
          <MultiTrackTimeline peaks={peaks} onError={onError} />
        </Panel>
      </PanelGroup>
    </div>
  );
}
