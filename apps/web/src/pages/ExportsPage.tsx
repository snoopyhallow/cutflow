import { useState } from "react";
import {
  Check,
  CircleNotch,
  Copy,
  DownloadSimple,
  Export,
  FilmSlate,
  Lightning,
  NotePencil,
  Scissors,
  Trash,
} from "@phosphor-icons/react";
import { StudioSelect } from "../components/ui/StudioControls";
import { formatTimecodeMs } from "../edl";
import type {
  ClipProjectSummary,
  ClipStatus,
  ExportSummary,
  PostCopyResponse,
  StudioTransport,
} from "../transport";

interface ExportsPageProps {
  transport: StudioTransport;
  projects: ClipProjectSummary[];
  exportsList: ExportSummary[];
  onOpenProject: (projectId: string) => void;
  onUpdateProjectStatus: (projectId: string, status: ClipStatus) => Promise<void>;
  onRefresh: () => Promise<void>;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function ExportsPage({
  transport,
  projects,
  exportsList,
  onOpenProject,
  onUpdateProjectStatus,
  onRefresh,
}: ExportsPageProps) {
  const [renderingId, setRenderingId] = useState<string | null>(null);
  const [copyBusyId, setCopyBusyId] = useState<string | null>(null);
  const [postCopyByProject, setPostCopyByProject] = useState<
    Record<string, PostCopyResponse>
  >({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function triggerExport(
    projectId: string,
    speedPreset: "draft" | "final",
  ) {
    setError(null);
    setRenderingId(`${projectId}:${speedPreset}`);
    try {
      await transport.exportProject(projectId, { speedPreset });
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRenderingId(null);
    }
  }

  async function handleGenerateCopy(projectId: string) {
    setError(null);
    setCopyBusyId(projectId);
    try {
      const res = await transport.generatePostCopy(projectId, "all");
      setPostCopyByProject((prev) => ({ ...prev, [projectId]: res }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCopyBusyId(null);
    }
  }

  function copyText(key: string, value: string) {
    void navigator.clipboard?.writeText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  }

  async function handleDelete(exportId: string) {
    setError(null);
    try {
      await transport.deleteExport(exportId);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="border-b border-[#222228] pb-3.5">
          <h1 className="text-base font-semibold tracking-tight text-[#F4F4F5]">
            Render Queue &amp; Delivery
          </h1>
          <p className="mt-0.5 text-xs text-[#A1A1AA]">
            Approve timelines, compile hardware-accelerated H.264/AAC masters, and generate social
            distribution copy.
          </p>
        </div>

        {error && (
          <div className="rounded-md border border-[#EF4444]/40 bg-[#EF4444]/10 px-3 py-2 text-xs text-[#FECACA]">
            {error}
          </div>
        )}

        {/* Clip Approval & Render Triggers */}
        {projects.length > 0 && (
          <section className="space-y-2.5">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[#71717A]">
              Project Staging ({projects.length})
            </h2>
            <div className="space-y-2">
              {projects.slice(0, 12).map((clip) => {
                const isDraftBusy = renderingId === `${clip.id}:draft`;
                const isFinalBusy = renderingId === `${clip.id}:final`;
                const anyBusy = renderingId !== null;
                const postCopy = postCopyByProject[clip.id];

                return (
                  <div
                    key={clip.id}
                    className="space-y-2.5 rounded-lg border border-[#222228] bg-[#111114] px-4 py-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2.5">
                          <span className="truncate text-xs font-semibold text-[#F4F4F5]">
                            {clip.title}
                          </span>
                          <StudioSelect
                            ariaLabel={`Status for ${clip.title}`}
                            value={clip.status}
                            className="w-28"
                            onChange={(st) =>
                              void onUpdateProjectStatus(clip.id, st as ClipStatus)
                            }
                            options={[
                              { value: "draft", label: "Draft" },
                              { value: "approved", label: "Approved" },
                              { value: "exported", label: "Exported" },
                              { value: "posted", label: "Posted" },
                              { value: "archived", label: "Archived" },
                            ]}
                          />
                        </div>
                        <div className="tabular-tc mt-1 text-[11px] text-[#71717A]">
                          {formatTimecodeMs(clip.totalDurationMs)} · {clip.wordCount} words · SCORE{" "}
                          {clip.score}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onOpenProject(clip.id)}
                          className="inline-flex items-center gap-1 rounded border border-[#282830] bg-[#18181C] px-2.5 py-1 text-xs text-[#D4D4D8] hover:border-[#3A3A44] hover:text-white"
                        >
                          <Scissors className="h-3.5 w-3.5" />
                          Cut Room
                        </button>
                        <button
                          type="button"
                          disabled={copyBusyId === clip.id}
                          onClick={() => void handleGenerateCopy(clip.id)}
                          className="inline-flex items-center gap-1 rounded border border-[#282830] bg-[#18181C] px-2.5 py-1 text-xs font-medium text-[#D4D4D8] hover:border-[#F59E0B]/50 hover:text-white disabled:opacity-40"
                        >
                          {copyBusyId === clip.id ? (
                            <CircleNotch className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <NotePencil className="h-3.5 w-3.5 text-[#F59E0B]" />
                          )}
                          Post Copy
                        </button>
                        <button
                          type="button"
                          disabled={anyBusy}
                          onClick={() => void triggerExport(clip.id, "draft")}
                          className="inline-flex items-center gap-1 rounded border border-[#2C2C35] bg-[#18181C] px-2.5 py-1 text-xs font-medium text-[#F4F4F5] hover:border-[#3F3F4C] disabled:opacity-40"
                        >
                          {isDraftBusy ? (
                            <CircleNotch className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Lightning className="h-3.5 w-3.5 text-[#A1A1AA]" />
                          )}
                          Draft
                        </button>
                        <button
                          type="button"
                          disabled={anyBusy}
                          onClick={() => void triggerExport(clip.id, "final")}
                          className="inline-flex items-center gap-1 rounded bg-[#F59E0B] px-3 py-1 text-xs font-semibold text-[#09090B] hover:bg-[#FBBF24] disabled:opacity-40"
                        >
                          {isFinalBusy ? (
                            <CircleNotch className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Export weight="bold" className="h-3.5 w-3.5" />
                          )}
                          Render Master
                        </button>
                      </div>
                    </div>

                    {postCopy && (
                      <div className="space-y-2 rounded-md border border-[#27272F] bg-[#09090B] p-3 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="tabular-tc text-[10px] font-semibold uppercase tracking-wider text-[#F59E0B]">
                            DISTRIBUTION COPY · {postCopy.provider}
                          </span>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => copyText(`${clip.id}:title`, postCopy.title)}
                              className="inline-flex items-center gap-1 rounded border border-[#222228] px-2 py-0.5 text-[10px] text-[#D4D4D8] hover:text-white"
                            >
                              {copiedKey === `${clip.id}:title` ? (
                                <Check className="h-3 w-3 text-[#22C55E]" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                              Title
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                copyText(`${clip.id}:tags`, postCopy.hashtags.join(" "))
                              }
                              className="inline-flex items-center gap-1 rounded border border-[#222228] px-2 py-0.5 text-[10px] text-[#D4D4D8] hover:text-white"
                            >
                              {copiedKey === `${clip.id}:tags` ? (
                                <Check className="h-3 w-3 text-[#22C55E]" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                              Tags
                            </button>
                            <button
                              type="button"
                              onClick={() => copyText(`${clip.id}:all`, postCopy.fullCopy)}
                              className="inline-flex items-center gap-1 rounded bg-[#F59E0B] px-2 py-0.5 text-[10px] font-semibold text-[#09090B] hover:bg-[#FBBF24]"
                            >
                              {copiedKey === `${clip.id}:all` ? (
                                <Check className="h-3 w-3" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                              Copy All
                            </button>
                          </div>
                        </div>
                        <div className="font-semibold text-[#F4F4F5]">{postCopy.title}</div>
                        <p className="text-[11px] text-[#A1A1AA]">{postCopy.description}</p>
                        <div className="tabular-tc flex flex-wrap gap-1.5 text-[11px] text-[#FBBF24]">
                          {postCopy.hashtags.map((tag) => (
                            <span key={tag}>{tag}</span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Rendered MP4 Masters */}
        <section className="space-y-2.5">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[#71717A]">
            Completed MP4 Renders ({exportsList.length})
          </h2>

          {exportsList.length === 0 ? (
            <div className="rounded-lg border border-[#222228] bg-[#111114] p-8 text-center text-xs text-[#71717A]">
              <FilmSlate className="mx-auto h-7 w-7 text-[#52525B]" />
              <p className="mt-2">
                No MP4 renders completed yet. Trigger Draft or Render Master above or from Cut Room.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {exportsList.map((exp) => {
                const dlUrl = transport.exportDownloadUrl(exp.id);
                return (
                  <div
                    key={exp.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#222228] bg-[#111114] px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-xs font-semibold text-[#F4F4F5]">
                          {exp.title}
                        </span>
                        <span className="tabular-tc rounded border border-[#282830] bg-[#18181C] px-1.5 py-0.5 text-[10px] font-medium text-[#D4D4D8]">
                          {exp.ratio} · {exp.quality}
                        </span>
                        <span className="tabular-tc rounded border border-[#22C55E]/30 bg-[#22C55E]/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-[#4ADE80]">
                          {exp.speedPreset}
                        </span>
                      </div>
                      <div className="tabular-tc mt-1 text-[11px] text-[#71717A]">
                        {formatTimecodeMs(exp.durationMs)} · {formatBytes(exp.sizeBytes)}
                        {exp.encoder ? ` · ${exp.encoder}` : ""}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {dlUrl ? (
                        <a
                          href={dlUrl}
                          download
                          className="inline-flex items-center gap-1 rounded bg-[#F59E0B] px-3 py-1.5 text-xs font-semibold text-[#09090B] hover:bg-[#FBBF24]"
                        >
                          <DownloadSimple weight="bold" className="h-3.5 w-3.5" />
                          Download MP4
                        </a>
                      ) : (
                        <span className="rounded border border-[#222228] px-2.5 py-1 text-[11px] text-[#71717A]">
                          Demo Render
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleDelete(exp.id)}
                        aria-label={`Delete export ${exp.title}`}
                        className="rounded border border-[#222228] p-1.5 text-[#A1A1AA] hover:border-[#EF4444]/40 hover:text-[#EF4444]"
                      >
                        <Trash className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
