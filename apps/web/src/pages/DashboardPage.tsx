import { useRef, useState, type DragEvent, type FormEvent } from "react";
import {
  Archive,
  Clapperboard,
  FolderSearch,
  FolderUp,
  HardDrive,
  Link2,
  Loader2,
  Radio,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { formatTimecodeMs } from "../edl";
import type {
  ClipProjectSummary,
  CreatorProfile,
  FeedItem,
  HypeCurvePoint,
  JobSummary,
  SourceSummary,
  StorageSummary,
  StudioTransport,
} from "../transport";

interface DashboardPageProps {
  transport: StudioTransport;
  profiles: CreatorProfile[];
  selectedProfileId: string;
  onSelectProfileId: (id: string) => void;
  sources: SourceSummary[];
  jobs: JobSummary[];
  projects: ClipProjectSummary[];
  feedItems: FeedItem[];
  storage: StorageSummary | null;
  onRefreshAll: () => Promise<void>;
  onJobStarted: (job: JobSummary) => void;
  onOpenProject: (projectId: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function HypeSparkline({ points }: { points: HypeCurvePoint[] }) {
  if (points.length < 2) return null;
  const width = 180;
  const height = 28;
  const pathData = points
    .map((pt, idx) => {
      const x = (idx / Math.max(1, points.length - 1)) * width;
      const y = height - Math.max(0.05, Math.min(1, pt.score)) * (height - 4) - 2;
      return `${idx === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible rounded bg-[#0B0D12] px-1"
      aria-label="Hype Curve"
    >
      <path
        d={pathData}
        fill="none"
        stroke="#10B981"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DashboardPage({
  transport,
  profiles,
  selectedProfileId,
  onSelectProfileId,
  sources,
  jobs,
  projects,
  feedItems,
  storage,
  onRefreshAll,
  onJobStarted,
  onOpenProject,
}: DashboardPageProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [noticeBanner, setNoticeBanner] = useState<string | null>(null);

  async function handleFileUpload(file: File) {
    setErrorBanner(null);
    setNoticeBanner(null);
    setBusyMessage(`Uploading ${file.name}...`);
    try {
      const res = await transport.uploadVideo(file, selectedProfileId || undefined);
      setNoticeBanner(`Queued "${res.source.title}" for automatic clipping.`);
      if (res.job) onJobStarted(res.job);
      await onRefreshAll();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMessage(null);
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFileUpload(file);
  }

  async function handleUrlSubmit(e: FormEvent) {
    e.preventDefault();
    const cleaned = urlInput.trim();
    if (!cleaned) return;
    setErrorBanner(null);
    setNoticeBanner(null);
    setBusyMessage("Validating URL & starting download...");
    try {
      const res = await transport.ingestUrl(cleaned, selectedProfileId || undefined);
      setUrlInput("");
      setNoticeBanner(`Queued URL ingest for "${res.source.title}".`);
      if (res.job) onJobStarted(res.job);
      await onRefreshAll();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMessage(null);
    }
  }

  async function handleScanInbox() {
    setErrorBanner(null);
    setBusyMessage("Scanning inbox drop-folders...");
    try {
      const res = await transport.scanInbox(selectedProfileId || undefined);
      setNoticeBanner(
        res.count > 0
          ? `Ingested ${res.count} video(s) from inbox folders.`
          : "No new videos found in inbox drop-folders.",
      );
      await onRefreshAll();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMessage(null);
    }
  }

  async function handlePollFeed() {
    setErrorBanner(null);
    setBusyMessage("Checking followed creator channels...");
    try {
      const res = await transport.pollFeed();
      setNoticeBanner(
        res.count > 0
          ? `Found ${res.count} new video(s) from followed creators.`
          : "Smart Feed is up to date.",
      );
      await onRefreshAll();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMessage(null);
    }
  }

  async function handleArchiveSource(sourceId: string) {
    setErrorBanner(null);
    try {
      const res = await transport.archiveSource(sourceId);
      setNoticeBanner(
        `Archived raw VOD (${formatBytes(res.reclaimedBytes)} reclaimed). All clip slices stay editable.`,
      );
      await onRefreshAll();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  }

  const activeFeed = feedItems.filter((f) => f.status === "new");
  const unarchivedSources = sources.filter((s) => !s.archived && s.durationMs > 0);

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* Top Row: Profile Selector + Quick Actions + Storage */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              AutoClip Studio Dashboard
            </h1>
            <p className="text-xs text-[#94A3B8]">
              Drop a VOD or paste a YouTube / Kick / Twitch link to generate editable viral clips.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Active Creator Profile"
              value={selectedProfileId}
              onChange={(e) => onSelectProfileId(e.target.value)}
              className="min-w-[210px] rounded-md border border-[#222836] bg-[#131720] px-3 py-1.5 text-xs font-medium text-white focus:border-[#6366F1] focus:outline-none"
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  Profile: {p.name}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => void handleScanInbox()}
              disabled={Boolean(busyMessage)}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#222836] bg-[#131720] px-2.5 py-1.5 text-xs font-medium text-[#CBD5E1] hover:border-[#2E374A] hover:text-white disabled:opacity-50"
            >
              <FolderSearch className="h-3.5 w-3.5 text-[#38BDF8]" />
              Scan Inbox
            </button>

            <button
              type="button"
              onClick={() => void handlePollFeed()}
              disabled={Boolean(busyMessage)}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#222836] bg-[#131720] px-2.5 py-1.5 text-xs font-medium text-[#CBD5E1] hover:border-[#2E374A] hover:text-white disabled:opacity-50"
            >
              <Radio className="h-3.5 w-3.5 text-[#10B981]" />
              Check Channels
            </button>

            {storage && (
              <div className="tabular-tc inline-flex items-center gap-1.5 rounded-md border border-[#222836] bg-[#131720] px-2.5 py-1.5 text-[11px] text-[#94A3B8]">
                <HardDrive className="h-3.5 w-3.5 text-[#8B5CF6]" />
                {formatBytes(storage.mediaBytes + storage.workBytes)} used ·{" "}
                {formatBytes(storage.diskFreeBytes)} free
              </div>
            )}
          </div>
        </div>

        {/* Feedback Banners */}
        {busyMessage && (
          <div className="flex items-center gap-2 rounded-lg border border-[#6366F1]/40 bg-[#6366F1]/10 px-3 py-2 text-xs text-[#E0E7FF]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {busyMessage}
          </div>
        )}
        {errorBanner && (
          <div className="flex items-center justify-between rounded-lg border border-[#F43F5E]/40 bg-[#F43F5E]/10 px-3 py-2 text-xs text-[#FECDD3]">
            <span>{errorBanner}</span>
            <button type="button" onClick={() => setErrorBanner(null)}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {noticeBanner && (
          <div className="flex items-center justify-between rounded-lg border border-[#10B981]/40 bg-[#10B981]/10 px-3 py-2 text-xs text-[#D1FAE5]">
            <span>{noticeBanner}</span>
            <button type="button" onClick={() => setNoticeBanner(null)}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Ingest Grid: Drag-and-Drop Zone + URL Paste Bar */}
        <div className="grid gap-4 lg:grid-cols-2">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click();
            }}
            className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
              isDragging
                ? "border-[#6366F1] bg-[#6366F1]/10"
                : "border-[#222836] bg-[#131720] hover:border-[#38445E]"
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".mp4,.mov,.mkv,.webm,.m4v,.avi"
              className="hidden"
              onChange={(e) => {
                const picked = e.target.files?.[0];
                if (picked) void handleFileUpload(picked);
                e.target.value = "";
              }}
            />
            <FolderUp className="h-8 w-8 text-[#6366F1]" />
            <p className="mt-2.5 text-sm font-semibold">
              Drop Video File or Click to Upload
            </p>
            <p className="mt-1 text-xs text-[#94A3B8]">
              MP4, MOV, MKV, WebM — auto-runs Hype Curve, Whisper, Highlights, and Lossless Slices
            </p>
          </div>

          <form
            onSubmit={(e) => void handleUrlSubmit(e)}
            className="flex flex-col justify-between rounded-xl border border-[#222836] bg-[#131720] p-6"
          >
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Link2 className="h-4 w-4 text-[#38BDF8]" />
                Multi-Platform URL Ingest
              </div>
              <p className="mt-1 text-xs text-[#94A3B8]">
                Paste a YouTube, Kick, Twitch, TikTok, or X link. YouTube heatmaps fuse directly
                into the Multi-Signal Hype Curve.
              </p>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <input
                type="url"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
                className="min-w-0 flex-1 rounded-md border border-[#222836] bg-[#0B0D12] px-3 py-2 text-xs text-white placeholder-[#64748B] focus:border-[#6366F1] focus:outline-none"
              />
              <button
                type="submit"
                disabled={Boolean(busyMessage) || !urlInput.trim()}
                className="inline-flex items-center gap-1.5 rounded-md bg-[#6366F1] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#5558E6] disabled:opacity-45"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Clip Now
              </button>
            </div>
          </form>
        </div>

        {/* Smart Feed ("New From Followed Creators") */}
        {activeFeed.length > 0 && (
          <section className="space-y-2.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[#94A3B8]">
              New From Followed Creators ({activeFeed.length})
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {activeFeed.map((item) => (
                <div
                  key={item.id}
                  className="flex flex-col justify-between rounded-lg border border-[#222836] bg-[#131720] p-3"
                >
                  <div>
                    <div className="line-clamp-2 text-xs font-semibold">{item.title}</div>
                    <div className="mt-1 text-[11px] text-[#94A3B8]">
                      {item.channel || item.profileId}
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        const res = await transport.clipFeedItem(item.id);
                        if (res.job) onJobStarted(res.job);
                        await onRefreshAll();
                      }}
                      className="flex-1 rounded bg-[#6366F1] px-2.5 py-1 text-xs font-medium text-white hover:bg-[#5558E6]"
                    >
                      Clip Now
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        await transport.dismissFeedItem(item.id);
                        await onRefreshAll();
                      }}
                      className="rounded border border-[#222836] px-2 py-1 text-xs text-[#94A3B8] hover:text-white"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Active & Recent Jobs Rail */}
        {jobs.length > 0 && (
          <section className="space-y-2.5">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-[#94A3B8]">
                Pipeline Jobs ({jobs.length})
              </h2>
              <button
                type="button"
                onClick={() => void onRefreshAll()}
                className="inline-flex items-center gap-1 text-[11px] text-[#94A3B8] hover:text-white"
              >
                <RefreshCw className="h-3 w-3" />
                Refresh
              </button>
            </div>
            <div className="space-y-2">
              {jobs.slice(0, 6).map((job) => {
                const pct = Math.round(job.progress * 100);
                const statusTone =
                  job.status === "done"
                    ? "text-[#10B981] bg-[#10B981]/10 border-[#10B981]/30"
                    : job.status === "failed"
                      ? "text-[#F43F5E] bg-[#F43F5E]/10 border-[#F43F5E]/30"
                      : "text-[#F59E0B] bg-[#F59E0B]/10 border-[#F59E0B]/30";
                return (
                  <div
                    key={job.id}
                    className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-[#222836] bg-[#131720] px-4 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-xs font-semibold">
                          {job.sourceTitle || job.sourceId}
                        </span>
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase ${statusTone}`}
                        >
                          {job.stage}
                        </span>
                      </div>
                      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[#0B0D12]">
                        <div
                          className="h-full rounded-full bg-[#6366F1] transition-all"
                          style={{ width: `${Math.max(4, pct)}%` }}
                        />
                      </div>
                      {job.error && (
                        <p className="mt-1 text-[11px] text-[#FDA4AF]">{job.error}</p>
                      )}
                    </div>

                    <div className="flex items-center gap-4">
                      <HypeSparkline points={job.hypeCurve} />
                      <div className="tabular-tc text-right text-[11px] text-[#94A3B8]">
                        <div className="font-semibold text-white">{pct}%</div>
                        <div>{job.clipCount} clip(s)</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Generated Clips Grid */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[#94A3B8]">
              Generated Clips ({projects.length})
            </h2>
            {unarchivedSources.length > 0 && (
              <div className="flex items-center gap-2">
                {unarchivedSources.slice(0, 2).map((src) => (
                  <button
                    key={src.id}
                    type="button"
                    onClick={() => void handleArchiveSource(src.id)}
                    className="inline-flex items-center gap-1 rounded border border-[#222836] bg-[#131720] px-2 py-1 text-[11px] text-[#94A3B8] hover:border-[#F59E0B]/50 hover:text-[#FDE68A]"
                  >
                    <Archive className="h-3 w-3" />
                    Archive Raw VOD ({src.title.slice(0, 18)})
                  </button>
                ))}
              </div>
            )}
          </div>

          {projects.length === 0 ? (
            <div className="rounded-xl border border-[#222836] bg-[#131720] p-8 text-center text-xs text-[#94A3B8]">
              No clips generated yet. Drop a video above to create your first viral clip batch.
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((clip) => {
                const thumbUrl = clip.hasThumb
                  ? transport.projectThumbUrl(clip.id)
                  : null;
                return (
                  <article
                    key={clip.id}
                    className="flex flex-col overflow-hidden rounded-xl border border-[#222836] bg-[#131720] transition-colors hover:border-[#6366F1]/60"
                  >
                    <div className="relative h-36 bg-gradient-to-br from-[#1E1B4B] via-[#131720] to-[#0F172A]">
                      {thumbUrl ? (
                        <img
                          src={thumbUrl}
                          alt={clip.title}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-xs text-[#64748B]">
                          EDL v1 Draft Preview
                        </div>
                      )}
                      <span className="tabular-tc absolute left-2.5 top-2.5 rounded-md bg-black/75 px-2 py-0.5 text-[11px] font-semibold text-[#10B981]">
                        Score {clip.score}
                      </span>
                      <span className="tabular-tc absolute bottom-2.5 right-2.5 rounded-md bg-black/75 px-2 py-0.5 text-[11px] text-white">
                        {formatTimecodeMs(clip.totalDurationMs)}
                      </span>
                    </div>

                    <div className="flex flex-1 flex-col justify-between p-3.5">
                      <div>
                        <h3 className="line-clamp-2 text-xs font-semibold leading-snug text-white">
                          {clip.title}
                        </h3>
                        {clip.reason && (
                          <p className="mt-1 line-clamp-2 text-[11px] text-[#94A3B8]">
                            {clip.reason}
                          </p>
                        )}
                      </div>

                      <div className="mt-3 flex items-center justify-between border-t border-[#222836] pt-2.5">
                        <span className="text-[11px] text-[#64748B]">
                          {clip.wordCount} words · {clip.status}
                        </span>
                        <button
                          type="button"
                          onClick={() => onOpenProject(clip.id)}
                          className="inline-flex items-center gap-1 rounded-md bg-[#6366F1] px-2.5 py-1 text-xs font-medium text-white hover:bg-[#5558E6]"
                        >
                          <Clapperboard className="h-3.5 w-3.5" />
                          Open in Editor
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
