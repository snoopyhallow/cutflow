import sampleEdlFixture from "@edl-schema/fixtures/sample_streamer_clip.edl.json";
import {
  applyBladeCut,
  autoTightenSilence,
  cloneEdl,
  getColdOpenDurationMs,
  getTotalDurationMs,
  insertWord,
  TimelineProjectSchema,
  type NormalizedBox,
  type TimelineProject,
} from "../edl";
import type {
  ClipProjectSummary,
  ClipStatus,
  CoEditorRequest,
  CoEditorResponse,
  CreatorProfile,
  DoctorReport,
  ExportRequestOptions,
  ExportSummary,
  FeedItem,
  HealthResponse,
  IngestResult,
  JobProgressEvent,
  JobSummary,
  PostCopyResponse,
  ProfileCreateInput,
  ProjectPeaks,
  SettingsResponse,
  SourceSummary,
  StorageSummary,
  StudioTransport,
  TimelineResponse,
} from "./types";

const DEMO_HYPE = [
  { startS: 0, endS: 10, score: 0.25 },
  { startS: 10, endS: 20, score: 0.42 },
  { startS: 20, endS: 30, score: 0.91 },
  { startS: 30, endS: 40, score: 0.58 },
  { startS: 40, endS: 50, score: 0.34 },
  { startS: 50, endS: 60, score: 0.77 },
];

export class DemoTransport implements StudioTransport {
  readonly mode = "demo" as const;
  private readonly profiles: CreatorProfile[] = [
    {
      id: "general-gaming-streamer",
      name: "General Gaming Streamer",
      creator_name: "Demo Streamer",
      brief:
        "High-energy gaming reactions, funny fails, clutch plays, and chaotic banter.",
      min_duration_s: 15,
      max_duration_s: 50,
      max_clips: 8,
      layout_mode: "auto_split",
      split_ratio: 0.35,
      title_card_style: "seam_card_white",
      cold_open_enabled: true,
      cold_open_duration_ms: 1500,
      cta_mode: "off",
      cta_text: "",
      reveal_mode: "progressive",
      caption_style: "bold_pop",
      burn_captions: true,
      censor_profanity: true,
      editor_boundaries: "Skip loading screens and donation reads unless punchline.",
      channel_urls: [],
      keyword_filters: [],
      auto_queue_feed: false,
      auto_export: false,
      inbox_path: "~/clip-farming/inbox/general-gaming-streamer",
    },
  ];
  private readonly sources: SourceSummary[] = [
    {
      id: "src_demo_001",
      sourceType: "upload",
      url: null,
      title: "GTA 6 Stream Highlights (Demo VOD)",
      channel: "Demo Streamer",
      durationMs: 120_000,
      width: 1920,
      height: 1080,
      fps: 60,
      archived: false,
      createdAt: "2026-11-24T12:00:00Z",
    },
  ];
  private readonly jobs: JobSummary[] = [
    {
      id: "job_demo_001",
      sourceId: "src_demo_001",
      sourceTitle: "GTA 6 Stream Highlights (Demo VOD)",
      profileId: "general-gaming-streamer",
      status: "done",
      stage: "done",
      progress: 1.0,
      error: null,
      clipCount: 1,
      hypeCurve: DEMO_HYPE,
      createdAt: "2026-11-24T12:00:00Z",
      updatedAt: "2026-11-24T12:01:00Z",
    },
  ];
  private readonly projects = new Map<string, TimelineProject>();
  private readonly exports: ExportSummary[] = [];
  private readonly feed: FeedItem[] = [];
  private demoBoundaries =
    "Keep edits snappy; never cut punchlines; keep white rounded seam card clean.";
  private demoModels = {
    active_provider: "gemini",
    scan_model: "gemini-2.5-flash",
    editor_model: "gemini-2.5-flash",
  };
  private readonly keysPresent: Record<string, boolean> = {
    gemini: false,
    groq: false,
    openai: false,
    anthropic: false,
    huggingface_token: false,
  };

  constructor() {
    const parsed = TimelineProjectSchema.parse(sampleEdlFixture);
    this.projects.set(parsed.projectId, parsed);
  }

  async health(): Promise<HealthResponse> {
    return {
      status: "ok",
      service: "cutflow-demo",
      version: "0.1.0",
      database: "memory",
      inbox_dir: "~/clip-farming/inbox",
    };
  }

  async listProfiles(): Promise<CreatorProfile[]> {
    return structuredClone(this.profiles);
  }

  async createProfile(input: ProfileCreateInput): Promise<CreatorProfile> {
    const slug = input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "creator";
    const created: CreatorProfile = {
      ...this.profiles[0],
      id: slug,
      name: input.name,
      creator_name: input.creator_name ?? "",
      brief: input.brief ?? "",
      min_duration_s: input.min_duration_s ?? 15,
      max_duration_s: input.max_duration_s ?? 50,
      max_clips: input.max_clips ?? 8,
      layout_mode: input.layout_mode ?? "auto_split",
      reveal_mode: input.reveal_mode ?? "progressive",
      title_card_style: input.title_card_style ?? "seam_card_white",
      channel_urls: input.channel_urls ?? [],
      keyword_filters: input.keyword_filters ?? [],
      inbox_path: `~/clip-farming/inbox/${slug}`,
    };
    this.profiles.push(created);
    return structuredClone(created);
  }

  async updateProfile(
    profileId: string,
    patch: Record<string, unknown>,
  ): Promise<CreatorProfile> {
    const idx = this.profiles.findIndex((p) => p.id === profileId);
    if (idx === -1) throw new Error("Profile not found.");
    this.profiles[idx] = { ...this.profiles[idx], ...patch, id: profileId };
    return structuredClone(this.profiles[idx]);
  }

  async deleteProfile(profileId: string): Promise<void> {
    if (this.profiles.length <= 1) {
      throw new Error("Keep at least one Creator Profile.");
    }
    const idx = this.profiles.findIndex((p) => p.id === profileId);
    if (idx !== -1) this.profiles.splice(idx, 1);
  }

  async pinWebcamToProfile(
    _projectId: string,
    _camBox: NormalizedBox,
    splitRatio: number,
  ): Promise<CreatorProfile> {
    this.profiles[0].split_ratio = splitRatio;
    return structuredClone(this.profiles[0]);
  }

  async listSources(): Promise<SourceSummary[]> {
    return structuredClone(this.sources);
  }

  async uploadVideo(file: File, profileId?: string): Promise<IngestResult> {
    return this.createDemoIngest("upload", null, file.name, profileId);
  }

  async ingestUrl(url: string, profileId?: string): Promise<IngestResult> {
    return this.createDemoIngest("url", url, url, profileId);
  }

  private createDemoIngest(
    sourceType: string,
    url: string | null,
    title: string,
    profileId?: string,
  ): IngestResult {
    const now = new Date().toISOString();
    const srcId = `src_${Date.now().toString(36)}`;
    const jobId = `job_${Date.now().toString(36)}`;
    const clipId = `clip_${Date.now().toString(36)}`;
    const source: SourceSummary = {
      id: srcId,
      sourceType,
      url,
      title,
      channel: "Demo Mode",
      durationMs: 21_500,
      width: 1920,
      height: 1080,
      fps: 60,
      archived: false,
      createdAt: now,
    };
    const job: JobSummary = {
      id: jobId,
      sourceId: srcId,
      sourceTitle: title,
      profileId: profileId ?? this.profiles[0].id,
      status: "done",
      stage: "done",
      progress: 1.0,
      error: null,
      clipCount: 1,
      hypeCurve: DEMO_HYPE,
      createdAt: now,
      updatedAt: now,
    };
    const edl = cloneEdl(TimelineProjectSchema.parse(sampleEdlFixture));
    edl.projectId = clipId;
    edl.sourceId = srcId;
    edl.title = `${title} — Highlight #1`;
    this.sources.unshift(source);
    this.jobs.unshift(job);
    this.projects.set(clipId, edl);
    return { source, job };
  }

  async archiveSource(
    sourceId: string,
  ): Promise<{ sourceId: string; archived: boolean; reclaimedBytes: number }> {
    const found = this.sources.find((s) => s.id === sourceId);
    if (found) found.archived = true;
    return { sourceId, archived: true, reclaimedBytes: 128 * 1024 * 1024 };
  }

  async getStorageSummary(): Promise<StorageSummary> {
    return {
      root: "~/.cutflow (Demo)",
      mediaBytes: 128 * 1024 * 1024,
      workBytes: 18 * 1024 * 1024,
      exportsBytes: 0,
      cacheBytes: 512 * 1024,
      diskFreeBytes: 400 * 1024 * 1024 * 1024,
      diskTotalBytes: 512 * 1024 * 1024 * 1024,
    };
  }

  async listJobs(): Promise<JobSummary[]> {
    return structuredClone(this.jobs);
  }

  subscribeJobEvents(
    jobId: string,
    onEvent: (evt: JobProgressEvent) => void,
  ): () => void {
    const found = this.jobs.find((j) => j.id === jobId);
    if (found) {
      queueMicrotask(() => {
        onEvent({
          jobId: found.id,
          sourceId: found.sourceId,
          profileId: found.profileId,
          status: found.status,
          stage: found.stage,
          progress: found.progress,
          error: found.error,
          hypeCurve: found.hypeCurve,
        });
      });
    }
    return () => undefined;
  }

  async listProjects(jobId?: string): Promise<ClipProjectSummary[]> {
    const items: ClipProjectSummary[] = [];
    let rank = 1;
    for (const edl of this.projects.values()) {
      const matchingJob =
        this.jobs.find((j) => j.sourceId === edl.sourceId) ?? this.jobs[0];
      if (jobId && matchingJob?.id !== jobId) continue;
      items.push({
        id: edl.projectId,
        jobId: matchingJob?.id ?? "job_demo_001",
        sourceId: edl.sourceId,
        rank,
        score: 92,
        title: edl.title,
        reason: "High-energy reaction climax with clean punchline boundary.",
        status: edl.status,
        totalDurationMs: getTotalDurationMs(edl),
        wordCount: edl.tracks.subtitles.words.length,
        hasSlice: true,
        hasPeaks: true,
        hasThumb: false,
        createdAt: matchingJob?.createdAt ?? "2026-11-24T12:00:00Z",
        updatedAt: matchingJob?.updatedAt ?? "2026-11-24T12:01:00Z",
      });
      rank += 1;
    }
    return items;
  }

  async getTimeline(projectId: string): Promise<TimelineResponse> {
    const found =
      this.projects.get(projectId) ?? this.projects.values().next().value;
    if (!found) {
      throw new Error(`Demo project '${projectId}' not found.`);
    }
    const copy = cloneEdl(found);
    return {
      edl: copy,
      totalDurationMs: getTotalDurationMs(copy),
      sliceOriginMs: 10_000,
    };
  }

  async saveTimeline(
    projectId: string,
    edl: TimelineProject,
  ): Promise<TimelineResponse> {
    const validated = TimelineProjectSchema.parse(edl);
    this.projects.set(projectId, cloneEdl(validated));
    return {
      edl: cloneEdl(validated),
      totalDurationMs: getTotalDurationMs(validated),
      sliceOriginMs: 10_000,
    };
  }

  async getProjectPeaks(projectId: string): Promise<ProjectPeaks> {
    const found =
      this.projects.get(projectId) ?? this.projects.values().next().value;
    const durationMs = found ? getTotalDurationMs(found) : 21_500;
    const rateHz = 100;
    const n = Math.max(100, Math.round((durationMs / 1000) * rateHz));
    const peaks = new Array<number>(n).fill(0.06);
    const rms = new Array<number>(n).fill(0.04);

    // Paint realistic speech bursts matching the EDL subtitle word intervals!
    const words = found?.tracks.subtitles.words ?? [];
    for (let i = 0; i < n; i += 1) {
      const tMs = (i / rateHz) * 1000;
      const inWord = words.some((w) => tMs >= w.startMs && tMs <= w.endMs);
      if (inWord) {
        const wave = 0.55 + 0.35 * Math.abs(Math.sin(i * 0.45)) + 0.1 * Math.cos(i * 1.1);
        peaks[i] = Number(Math.min(1, wave).toFixed(3));
        rms[i] = Number(Math.min(1, wave * 0.72).toFixed(3));
      } else {
        const bg = 0.05 + 0.04 * Math.abs(Math.sin(i * 0.2));
        peaks[i] = Number(bg.toFixed(3));
        rms[i] = Number((bg * 0.6).toFixed(3));
      }
    }
    return { rateHz, durationMs, peaks, rms };
  }

  projectMediaUrl(_projectId: string): string | null {
    return "/demo/sample_clip.mp4";
  }

  projectThumbUrl(_projectId: string): string | null {
    return null;
  }

  async exportProject(
    projectId: string,
    opts?: ExportRequestOptions,
  ): Promise<ExportSummary> {
    const edl =
      this.projects.get(projectId) ?? this.projects.values().next().value;
    const summary: ExportSummary = {
      id: `exp_${Date.now().toString(36)}`,
      projectId: edl?.projectId ?? projectId,
      title: edl?.title ?? projectId,
      ratio: opts?.ratio ?? edl?.output.ratio ?? "9:16",
      quality: opts?.quality ?? edl?.output.quality ?? "1080p",
      speedPreset: opts?.speedPreset ?? edl?.output.speedPreset ?? "final",
      sizeBytes: 8_400_000,
      durationMs: edl ? getTotalDurationMs(edl) : 21_500,
      encoder: "libx264 (demo)",
      createdAt: new Date().toISOString(),
    };
    this.exports.unshift(summary);
    return structuredClone(summary);
  }

  async listExports(projectId?: string): Promise<ExportSummary[]> {
    const filtered = projectId
      ? this.exports.filter((e) => e.projectId === projectId)
      : this.exports;
    return structuredClone(filtered);
  }

  async runCoEditor(
    projectId: string,
    req: CoEditorRequest,
  ): Promise<CoEditorResponse> {
    const current =
      this.projects.get(projectId) ?? this.projects.values().next().value;
    if (!current) {
      throw new Error(`Demo project '${projectId}' not found.`);
    }
    if (req.saveBoundaries && req.boundaries !== undefined) {
      this.demoBoundaries = req.boundaries.trim();
    }
    const before = cloneEdl(current);
    let next = cloneEdl(current);
    const applied: string[] = [];
    const ops: Record<string, unknown>[] = [];
    const text = req.instruction.trim();
    const lower = text.toLowerCase();

    const cutMatch = text.match(
      /(?:cut|remove|delete|trim)\s+(?:from\s+)?(\d+(?:\.\d+)?)\s*s?\s*(?:to|-|–)\s*(\d+(?:\.\d+)?)\s*s?/i,
    );
    if (cutMatch) {
      const sMs = Math.round(parseFloat(cutMatch[1]) * 1000);
      const eMs = Math.round(parseFloat(cutMatch[2]) * 1000);
      next = applyBladeCut(next, sMs, eMs);
      applied.push(`Cut ${(sMs / 1000).toFixed(1)}–${(eMs / 1000).toFixed(1)}s`);
      ops.push({ op: "blade_cut", cutStartMs: sMs, cutEndMs: eMs });
    } else if (
      lower.includes("tighten silence") ||
      lower.includes("dead air") ||
      lower.includes("jump cut")
    ) {
      const tightened = autoTightenSilence(next, { minGapMs: 1100 });
      if (tightened.cutsApplied > 0) {
        next = tightened.edl;
        applied.push(
          `Tightened ${tightened.cutsApplied} silent gap(s) (-${(tightened.savedMs / 1000).toFixed(1)}s)`,
        );
        ops.push({ op: "tighten_silence", minGapMs: 1100 });
      }
    } else if (lower.includes("cut pause") || lower.includes("cut 2s")) {
      const sMs = Math.max(getColdOpenDurationMs(next), req.playheadMs ?? 0);
      const eMs = Math.min(getTotalDurationMs(next), sMs + 2000);
      next = applyBladeCut(next, sMs, eMs);
      applied.push(`Cut ${(sMs / 1000).toFixed(1)}–${(eMs / 1000).toFixed(1)}s`);
      ops.push({ op: "blade_cut", cutStartMs: sMs, cutEndMs: eMs });
    }

    if (lower.includes("single word") || lower.includes("single_word")) {
      next.tracks.subtitles.style.revealMode = "single_word";
      applied.push("Reveal mode → single_word");
      ops.push({ op: "set_subtitles", revealMode: "single_word" });
    } else if (lower.includes("progressive")) {
      next.tracks.subtitles.style.revealMode = "progressive";
      applied.push("Reveal mode → progressive");
      ops.push({ op: "set_subtitles", revealMode: "progressive" });
    } else if (lower.includes("captions off") || lower.includes("hide captions")) {
      next.tracks.subtitles.enabled = false;
      applied.push("Subtitles → off");
      ops.push({ op: "set_subtitles", enabled: false });
    }

    const quoted = text.match(/['"]([^'"]{1,120})['"]/);
    if (
      (lower.includes("insert") || lower.includes("add word") || lower.includes("add '") || lower.includes('add "')) &&
      quoted
    ) {
      const atMatch = text.match(/\bat\s+(\d+(?:\.\d+)?)\s*s?\b/i);
      const atMs = atMatch ? Math.round(parseFloat(atMatch[1]) * 1000) : (req.playheadMs ?? 3000);
      next = insertWord(next, quoted[1], atMs, 750);
      applied.push(`Inserted '${quoted[1]}' at ${(atMs / 1000).toFixed(1)}s`);
      ops.push({ op: "insert_word", text: quoted[1], startMs: atMs });
    } else if ((lower.includes("title") || lower.includes("seam")) && quoted) {
      const existing = next.tracks.overlays.find((o) => o.kind === "seam_card_white");
      if (existing) {
        existing.text = quoted[1];
      }
      applied.push(`Seam title → '${quoted[1]}'`);
      ops.push({ op: "set_seam_title", text: quoted[1] });
    }

    if (lower.includes("remove cold") || lower.includes("no cold open")) {
      next.tracks.video.coldOpen = null;
      applied.push("Cold-open → off");
      ops.push({ op: "set_cold_open", enabled: false });
    }

    if (applied.length > 0) {
      this.projects.set(next.projectId, cloneEdl(next));
    }

    return {
      edl: cloneEdl(next),
      previousEdl: before,
      applied,
      ops,
      reply:
        applied.length > 0
          ? "Applied your edit optimistically to the timeline."
          : "Try commands like \"cut 4s to 7s\", \"change title to 'WAIT FOR IT'\", \"single word captions\", or \"insert 'SIU!' at 5s\".",
      provider: "demo-rules",
      boundaries: req.boundaries ?? this.demoBoundaries,
      totalDurationMs: getTotalDurationMs(next),
    };
  }

  async updateProjectStatus(
    projectId: string,
    status: ClipStatus,
  ): Promise<ClipProjectSummary> {
    const found = this.projects.get(projectId);
    if (found) {
      found.status = status;
    }
    const list = await this.listProjects();
    const item = list.find((p) => p.id === projectId);
    if (!item) throw new Error(`Demo project '${projectId}' not found.`);
    return item;
  }

  async generatePostCopy(
    projectId: string,
    platform: "tiktok" | "shorts" | "reels" | "all" = "all",
  ): Promise<PostCopyResponse> {
    const found =
      this.projects.get(projectId) ?? this.projects.values().next().value;
    const title = found?.title || "You Won't Believe This Clip";
    const hashtags = ["#clips", "#shorts", "#gaming", "#streamer", "#viral", "#fyp"];
    const description = `${title} — wait for the reaction! Drop a comment if you caught that.`;
    return {
      platform,
      title,
      description,
      hashtags,
      fullCopy: `${title}\n\n${description}\n\n${hashtags.join(" ")}`,
      provider: "demo-rules",
    };
  }

  exportDownloadUrl(_exportId: string): string | null {
    return null;
  }

  async deleteExport(exportId: string): Promise<void> {
    const idx = this.exports.findIndex((e) => e.id === exportId);
    if (idx !== -1) this.exports.splice(idx, 1);
  }

  async scanInbox(): Promise<{ count: number }> {
    return { count: 0 };
  }

  async listFeed(): Promise<FeedItem[]> {
    return structuredClone(this.feed);
  }

  async pollFeed(): Promise<{ count: number }> {
    return { count: 0 };
  }

  async clipFeedItem(feedId: string): Promise<IngestResult> {
    return this.ingestUrl(`https://example.com/watch?v=${feedId}`);
  }

  async dismissFeedItem(feedId: string): Promise<void> {
    const found = this.feed.find((f) => f.id === feedId);
    if (found) found.status = "dismissed";
  }

  async getSettings(): Promise<SettingsResponse> {
    return {
      settings: {
        models: { ...this.demoModels },
        alignment: {
          whisper_model: "medium",
          forced_aligner: "auto",
        },
        export: {
          editor_boundaries: this.demoBoundaries,
        },
      },
      keys_present: { ...this.keysPresent },
    };
  }

  async saveSettings(patch: Record<string, unknown>): Promise<SettingsResponse> {
    const mod = patch.models as
      | { active_provider?: string; scan_model?: string; editor_model?: string }
      | undefined;
    if (mod) {
      this.demoModels = {
        active_provider: mod.active_provider ?? this.demoModels.active_provider,
        scan_model: mod.scan_model ?? this.demoModels.scan_model,
        editor_model: mod.editor_model ?? this.demoModels.editor_model,
      };
    }
    const exp = patch.export as { editor_boundaries?: string } | undefined;
    if (exp?.editor_boundaries !== undefined) {
      this.demoBoundaries = exp.editor_boundaries;
    }
    return this.getSettings();
  }

  async getDoctor(): Promise<DoctorReport> {
    return {
      version: "0.1.0",
      platform: "Hosted Interactive Demo (Browser)",
      python: "3.12 (Local Studio)",
      ffmpeg: "Static Demo Transport (no server required)",
      libass: true,
      ytDlp: true,
      gpu: "Browser 60fps Canvas2D",
      nvencOk: true,
      nvencDetail: "Client-side Demo Mode active",
      dataRoot: "In-Memory Demo",
      freeGb: 400.0,
      inboxRoot: "~/clip-farming/inbox",
    };
  }

  async setSecret(key: string, _value: string): Promise<void> {
    this.keysPresent[key] = true;
  }

  async deleteSecret(key: string): Promise<void> {
    this.keysPresent[key] = false;
  }
}
