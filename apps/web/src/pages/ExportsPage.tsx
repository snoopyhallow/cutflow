import { useState } from "react";
import {
  Check,
  Clapperboard,
  Copy,
  Download,
  Film,
  Loader2,
  Rocket,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";
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
        <div>
          <h1 className="text-base font-semibold">Exports &amp; Social Delivery Queue</h1>
          <p className="mt-0.5 text-xs text-[#94A3B8]">
            Approve clips (Draft → Approved → Exported → Posted), render Draft or Final MP4s, and
            generate 1-click TikTok / Shorts / Reels post copy.
          </p>
        </div>

        {error && (
          <div className="rounded-lg border border-[#F43F5E]/40 bg-[#F43F5E]/10 px-3 py-2 text-xs text-[#FECDD3]">
            {error}
          </div>
        )}

        {/* Clips Approval, Quick Render & Post Copy */}
        {projects.length > 0 && (
          <section className="space-y-2.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[#94A3B8]">
              Clip Pipeline ({projects.length})
            </h2>
            <div className="space-y-2.5">
              {projects.slice(0, 10).map((clip) => {
                const isDraftBusy = renderingId === `${clip.id}:draft`;
                const isFinalBusy = renderingId === `${clip.id}:final`;
                const anyBusy = renderingId !== null;
                const postCopy = postCopyByProject[clip.id];

                return (
                  <div
                    key={clip.id}
                    className="space-y-2.5 rounded-lg border border-[#222836] bg-[#131720] px-4 py-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-xs font-semibold text-white">
                            {clip.title}
                          </span>
                          <select
                            aria-label={`Approval status for ${clip.title}`}
                            value={clip.status}
                            onChange={(e) =>
                              void onUpdateProjectStatus(
                                clip.id,
                                e.target.value as ClipStatus,
                              )
                            }
                            className="rounded border border-[#222836] bg-[#0B0D12] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[#CBD5E1]"
                          >
                            <option value="draft">Draft</option>
                            <option value="approved">Approved</option>
                            <option value="exported">Exported</option>
                            <option value="posted">Posted</option>
                            <option value="archived">Archived</option>
                          </select>
                        </div>
                        <div className="tabular-tc mt-0.5 text-[11px] text-[#94A3B8]">
                          {formatTimecodeMs(clip.totalDurationMs)} · {clip.wordCount} words · Score{" "}
                          {clip.score}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onOpenProject(clip.id)}
                          className="inline-flex items-center gap-1 rounded border border-[#222836] px-2.5 py-1 text-xs text-[#CBD5E1] hover:border-[#2E374A] hover:text-white"
                        >
                          <Clapperboard className="h-3.5 w-3.5" />
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={copyBusyId === clip.id}
                          onClick={() => void handleGenerateCopy(clip.id)}
                          className="inline-flex items-center gap-1 rounded border border-[#F59E0B]/40 bg-[#F59E0B]/10 px-2.5 py-1 text-xs font-medium text-[#FDE68A] hover:bg-[#F59E0B]/20 disabled:opacity-45"
                        >
                          {copyBusyId === clip.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Sparkles className="h-3.5 w-3.5" />
                          )}
                          Post Copy
                        </button>
                        <button
                          type="button"
                          disabled={anyBusy}
                          onClick={() => void triggerExport(clip.id, "draft")}
                          className="inline-flex items-center gap-1 rounded border border-[#38BDF8]/40 bg-[#38BDF8]/10 px-2.5 py-1 text-xs font-medium text-[#E0F2FE] hover:bg-[#38BDF8]/20 disabled:opacity-45"
                        >
                          {isDraftBusy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Zap className="h-3.5 w-3.5" />
                          )}
                          Draft
                        </button>
                        <button
                          type="button"
                          disabled={anyBusy}
                          onClick={() => void triggerExport(clip.id, "final")}
                          className="inline-flex items-center gap-1 rounded bg-[#6366F1] px-2.5 py-1 text-xs font-medium text-white hover:bg-[#5558E6] disabled:opacity-45"
                        >
                          {isFinalBusy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Rocket className="h-3.5 w-3.5" />
                          )}
                          Export Final
                        </button>
                      </div>
                    </div>

                    {/* Generated Viral Post Copy Card */}
                    {postCopy && (
                      <div className="space-y-2 rounded-lg border border-[#F59E0B]/30 bg-[#0B0D12] p-3 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-semibold uppercase tracking-wider text-[#F59E0B]">
                            Viral Post Copy ({postCopy.provider})
                          </span>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => copyText(`${clip.id}:title`, postCopy.title)}
                              className="inline-flex items-center gap-1 rounded border border-[#222836] px-2 py-0.5 text-[10px] text-[#CBD5E1] hover:text-white"
                            >
                              {copiedKey === `${clip.id}:title` ? (
                                <Check className="h-3 w-3 text-[#10B981]" />
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
                              className="inline-flex items-center gap-1 rounded border border-[#222836] px-2 py-0.5 text-[10px] text-[#CBD5E1] hover:text-white"
                            >
                              {copiedKey === `${clip.id}:tags` ? (
                                <Check className="h-3 w-3 text-[#10B981]" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                              Hashtags
                            </button>
                            <button
                              type="button"
                              onClick={() => copyText(`${clip.id}:all`, postCopy.fullCopy)}
                              className="inline-flex items-center gap-1 rounded bg-[#6366F1] px-2 py-0.5 text-[10px] font-medium text-white hover:bg-[#5558E6]"
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
                        <div className="font-semibold text-white">{postCopy.title}</div>
                        <p className="text-[11px] text-[#94A3B8]">{postCopy.description}</p>
                        <div className="flex flex-wrap gap-1.5 text-[11px] text-[#38BDF8]">
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

        {/* Completed Exports */}
        <section className="space-y-2.5">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[#94A3B8]">
            Completed MP4 Exports ({exportsList.length})
          </h2>

          {exportsList.length === 0 ? (
            <div className="rounded-xl border border-[#222836] bg-[#131720] p-8 text-center text-xs text-[#94A3B8]">
              <Film className="mx-auto h-8 w-8 text-[#64748B]" />
              <p className="mt-2">
                No MP4s rendered yet. Click Draft or Export Final above (or inside the Editor) to
                compile an EDL to MP4.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {exportsList.map((exp) => {
                const dlUrl = transport.exportDownloadUrl(exp.id);
                return (
                  <div
                    key={exp.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#222836] bg-[#131720] px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-xs font-semibold text-white">
                          {exp.title}
                        </span>
                        <span className="rounded bg-[#1A202C] px-1.5 py-0.5 text-[10px] font-medium text-[#38BDF8]">
                          {exp.ratio} · {exp.quality}
                        </span>
                        <span className="rounded bg-[#10B981]/15 px-1.5 py-0.5 text-[10px] font-medium uppercase text-[#10B981]">
                          {exp.speedPreset}
                        </span>
                      </div>
                      <div className="tabular-tc mt-1 text-[11px] text-[#94A3B8]">
                        {formatTimecodeMs(exp.durationMs)} · {formatBytes(exp.sizeBytes)}
                        {exp.encoder ? ` · ${exp.encoder}` : ""}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {dlUrl ? (
                        <a
                          href={dlUrl}
                          download
                          className="inline-flex items-center gap-1 rounded bg-[#10B981] px-3 py-1.5 text-xs font-semibold text-[#042F2E] hover:bg-[#34D399]"
                        >
                          <Download className="h-3.5 w-3.5" />
                          Download MP4
                        </a>
                      ) : (
                        <span className="rounded border border-[#222836] px-2.5 py-1 text-[11px] text-[#64748B]">
                          Demo Export
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleDelete(exp.id)}
                        aria-label={`Delete export ${exp.title}`}
                        className="rounded border border-[#222836] p-1.5 text-[#94A3B8] hover:border-[#F43F5E]/40 hover:text-[#F43F5E]"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
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
