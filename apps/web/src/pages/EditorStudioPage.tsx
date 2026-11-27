import { useMemo, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  ArrowCounterClockwise,
  SlidersHorizontal,
  Sparkle,
} from "@phosphor-icons/react";
import { AiCoEditorPanel } from "../components/agent/AiCoEditorPanel";
import { StudioStage } from "../components/canvas/StudioStage";
import { ResourceDrawer } from "../components/drawer/ResourceDrawer";
import { ContextInspector } from "../components/inspector/ContextInspector";
import { MultiTrackTimeline } from "../components/timeline/MultiTrackTimeline";
import { useTimelineStore } from "../state/timelineStore";
import type {
  BgmAssetItem,
  ClipProjectSummary,
  ClipStatus,
  ProjectPeaks,
  SourceSummary,
  StudioTransport,
} from "../transport";

interface EditorStudioPageProps {
  transport: StudioTransport;
  sources: SourceSummary[];
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
  onRefreshWorkspace: () => Promise<void>;
  onRefreshBgm: () => Promise<void>;
  onExportNow: () => Promise<void>;
  onError: (msg: string) => void;
}

export function EditorStudioPage({
  transport,
  sources,
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
  onRefreshWorkspace,
  onRefreshBgm,
  onExportNow,
  onError,
}: EditorStudioPageProps) {
  const {
    edl,
    rightDockTab,
    aiSelectionPromptLabel,
    lastAiPatch,
    setRightDockTab,
    applyAiPatchResult,
    revertLastAiPatch,
  } = useTimelineStore();

  const [transcribing, setTranscribing] = useState(false);

  const activeBgmUrl = useMemo(() => {
    const assetId = edl?.tracks.audio.bgm?.assetId;
    if (!assetId) return null;
    return transport.bgmMediaUrl(assetId);
  }, [edl?.tracks.audio.bgm?.assetId, transport]);

  async function handleAutoCaptions(language?: string) {
    if (!edl || transcribing) return;
    const targetId = activeProjectId ?? edl.projectId;
    setTranscribing(true);
    try {
      const res = await transport.transcribeProject(targetId, language);
      applyAiPatchResult(res.edl, [
        `Auto-Captions: ${res.wordCount} words (${res.provider})`,
      ]);
      await onRefreshWorkspace();
    } catch (err) {
      onError(
        `Auto-captions failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setTranscribing(false);
    }
  }

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
          <span className="truncate">
            Applied: {lastAiPatch.summary.join(" · ")}
          </span>
          <button
            type="button"
            onClick={revertLastAiPatch}
            className="ml-2 inline-flex shrink-0 items-center gap-1 rounded border border-[#32323B] bg-[#141418] px-2 py-0.5 text-xs font-medium text-[#F4F4F5] hover:bg-[#202026]"
          >
            <ArrowCounterClockwise className="h-3 w-3" />
            Revert
          </button>
        </div>
      )}

      <PanelGroup direction="vertical" className="min-h-0 flex-1">
        {/* Top Row: Left 6-Tab Resource Drawer | Center Interactive Canvas | Right Inspector + AI Co-Editor Dock */}
        <Panel defaultSize={60} minSize={34}>
          <PanelGroup direction="horizontal" className="h-full">
            {/* Zone 1: Top-Left 6-Tab Resource Drawer */}
            <Panel defaultSize={25} minSize={18}>
              <ResourceDrawer
                transport={transport}
                sources={sources}
                projects={projects}
                bgmAssets={bgmAssets}
                activeProjectId={activeProjectId}
                transcribing={transcribing}
                onAutoCaptions={handleAutoCaptions}
                onSelectProject={onSelectProject}
                onUpdateProjectStatus={onUpdateProjectStatus}
                onRefreshWorkspace={onRefreshWorkspace}
                onRefreshBgm={onRefreshBgm}
                onError={onError}
              />
            </Panel>

            <PanelResizeHandle className="w-px bg-[#222228] transition-colors hover:bg-[#F59E0B]" />

            {/* Zone 2: Top-Center Interactive Canvas & WebAudio Mixer */}
            <Panel defaultSize={45} minSize={28}>
              <StudioStage
                mediaUrl={mediaUrl}
                bgmUrl={activeBgmUrl}
                peaks={peaks}
                transport={transport}
              />
            </Panel>

            <PanelResizeHandle className="w-px bg-[#222228] transition-colors hover:bg-[#F59E0B]" />

            {/* Zone 3: Top-Right Tabbed Inspector | AI Co-Editor Dock */}
            <Panel defaultSize={30} minSize={22}>
              <div className="flex h-full flex-col border-l border-[#222228] bg-[#111114]">
                <div className="grid grid-cols-2 border-b border-[#222228] bg-[#09090B] text-[11px] font-semibold">
                  <button
                    type="button"
                    onClick={() => setRightDockTab("inspector")}
                    className={`flex items-center justify-center gap-1.5 border-b-2 py-2 transition-colors ${
                      rightDockTab === "inspector"
                        ? "border-[#F59E0B] bg-[#111114] text-[#F4F4F5]"
                        : "border-transparent text-[#71717A] hover:text-[#D4D4D8]"
                    }`}
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    Inspector
                  </button>
                  <button
                    type="button"
                    onClick={() => setRightDockTab("coeditor")}
                    className={`relative flex items-center justify-center gap-1.5 border-b-2 py-2 transition-colors ${
                      rightDockTab === "coeditor"
                        ? "border-[#F59E0B] bg-[#111114] text-[#F4F4F5]"
                        : "border-transparent text-[#71717A] hover:text-[#D4D4D8]"
                    }`}
                  >
                    <Sparkle
                      weight={rightDockTab === "coeditor" ? "fill" : "regular"}
                      className="h-3.5 w-3.5 text-[#F59E0B]"
                    />
                    AI Co-Editor
                    {aiSelectionPromptLabel && rightDockTab !== "coeditor" && (
                      <span className="h-1.5 w-1.5 rounded-full bg-[#F59E0B]" />
                    )}
                  </button>
                </div>

                <div className="min-h-0 flex-1">
                  {rightDockTab === "coeditor" ? (
                    <AiCoEditorPanel
                      transport={transport}
                      projectId={activeProjectId}
                      initialBoundaries={initialBoundaries}
                    />
                  ) : (
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
                  )}
                </div>
              </div>
            </Panel>
          </PanelGroup>
        </Panel>

        <PanelResizeHandle className="h-px bg-[#222228] transition-colors hover:bg-[#F59E0B]" />

        {/* Zone 4: Bottom 7-Track NLE Timeline */}
        <Panel defaultSize={40} minSize={24}>
          <MultiTrackTimeline
            peaks={peaks}
            filmstripUrl={filmstripUrl}
            bgmAssets={bgmAssets}
            onError={onError}
            onAutoCaptions={() => void handleAutoCaptions()}
          />
        </Panel>
      </PanelGroup>
    </div>
  );
}
