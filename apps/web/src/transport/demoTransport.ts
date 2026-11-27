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
  AiModelsResponse,
  BgmAssetItem,
  BlankProjectCreateInput,
  BlankProjectCreateResponse,
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
  LocalPathImportOptions,
  MashupCreateInput,
  MashupCreateResponse,
  PostCopyResponse,
  ProfileCreateInput,
  ProjectPeaks,
  SettingsResponse,
  SfxAssetItem,
  SourceSummary,
  StorageSummary,
  StudioTransport,
  TimelineResponse,
  TranscribeProjectResponse,
  UrlIngestOptions,
  UrlProbeResponse,
} from "./types";

const DEMO_HYPE = [
  { startS: 0, endS: 10, score: 0.25 },
  { startS: 10, endS: 20, score: 0.42 },
  { startS: 20, endS: 30, score: 0.91 },
  { startS: 30, endS: 40, score: 0.58 },
  { startS: 40, endS: 50, score: 0.34 },
  { startS: 50, endS: 60, score: 0.84 },
];

const BLOCKED_HOSTS = [
  "kisskh.",
  "fmovies",
  "123movies",
  "soap2day",
  "hianime",
  "9anime",
  "gogoanime",
  "netflix.com",
  "disneyplus.com",
];

export class DemoTransport implements StudioTransport {
  readonly mode = "demo" as const;
  private readonly profiles: CreatorProfile[] = [
    {
      id: "cinema-tv-edits",
      name: "Cinema & TV Edits (JJ_EDIT Style)",
      creator_name: "Cinema Studio",
      brief:
        "Dramatic movie & prestige TV dialogue climaxes, cold realizations, and razor-sharp tension.",
      content_mode: "cinema",
      preferred_lang: "en",
      min_duration_s: 18,
      max_duration_s: 65,
      max_clips: 6,
      default_ratio: "1:1",
      layout_mode: "auto_reframe",
      fit_backdrop: "black",
      split_ratio: 0.35,
      border_style: "thin_rounded",
      cinema_grade: "crisp_hd",
      title_card_style: "pov_top_bar",
      cold_open_enabled: false,
      cold_open_duration_ms: 1500,
      cta_mode: "off",
      cta_text: "",
      watermark_text: "CUTFLOW",
      watermark_opacity: 0.78,
      show_cinema_credit: true,
      transition_style: "dip_black",
      transition_sfx: "cinema_hit",
      bgm_mode: "auto_mood",
      bgm_mood: "dark_cinema",
      bgm_asset_id: "dark_cinema_pulse",
      dialogue_enhance: true,
      auto_tighten_silence: false,
      reveal_mode: "group",
      caption_style: "cinema_neon_glow",
      burn_captions: true,
      censor_profanity: false,
      margin_v_ratio: 0.4,
      editor_boundaries: "Preserve dramatic pauses; never cut mid-sentence.",
      channel_urls: [],
      keyword_filters: [],
      auto_queue_feed: false,
      auto_export: false,
      inbox_path: "~/.cutflow/inbox/cinema-tv-edits",
    },
    {
      id: "viral-gaming-challenge",
      name: "Viral Gaming Challenge (MrBeast Style)",
      creator_name: "Challenge Crew",
      brief:
        "High-stakes gaming challenges, money/score reveals, flash transitions, and punch-word glow.",
      content_mode: "stream",
      preferred_lang: "en",
      min_duration_s: 15,
      max_duration_s: 55,
      max_clips: 8,
      default_ratio: "9:16",
      layout_mode: "auto_reframe",
      fit_backdrop: "blur",
      split_ratio: 0.35,
      border_style: "none",
      cinema_grade: "crisp_hd",
      title_card_style: "off",
      cold_open_enabled: true,
      cold_open_duration_ms: 1400,
      cta_mode: "off",
      cta_text: "",
      watermark_text: "",
      watermark_opacity: 0.78,
      show_cinema_credit: false,
      transition_style: "flash_white",
      transition_sfx: "whoosh_flash",
      bgm_mode: "auto_mood",
      bgm_mood: "upbeat_gaming",
      bgm_asset_id: "upbeat_challenge_drive",
      dialogue_enhance: true,
      auto_tighten_silence: true,
      reveal_mode: "progressive",
      caption_style: "viral_punch_glow",
      burn_captions: true,
      censor_profanity: true,
      margin_v_ratio: 0.38,
      editor_boundaries: "Tighten dead air aggressively; highlight numbers and stakes.",
      channel_urls: [],
      keyword_filters: [],
      auto_queue_feed: false,
      auto_export: false,
      inbox_path: "~/.cutflow/inbox/viral-gaming-challenge",
    },
    {
      id: "general-gaming-streamer",
      name: "General Gaming Streamer",
      creator_name: "Demo Streamer",
      brief:
        "High-energy gaming reactions, funny fails, clutch plays, and chaotic banter.",
      content_mode: "stream",
      preferred_lang: "en",
      min_duration_s: 15,
      max_duration_s: 50,
      max_clips: 8,
      default_ratio: "9:16",
      layout_mode: "auto_split",
      fit_backdrop: "blur",
      split_ratio: 0.35,
      border_style: "none",
      cinema_grade: "off",
      title_card_style: "seam_card_white",
      cold_open_enabled: true,
      cold_open_duration_ms: 1500,
      cta_mode: "off",
      cta_text: "",
      reveal_mode: "progressive",
      caption_style: "bold_pop",
      burn_captions: true,
      censor_profanity: true,
      margin_v_ratio: 0.22,
      editor_boundaries: "Skip loading screens and donation reads unless punchline.",
      channel_urls: [],
      keyword_filters: [],
      auto_queue_feed: false,
      auto_export: false,
      inbox_path: "~/.cutflow/inbox/general-gaming-streamer",
    },
  ];
  private readonly sources: SourceSummary[] = [
    {
      id: "src_demo_001",
      sourceType: "upload",
      url: null,
      title: "GTA VI Stream & Cinema Highlights (Demo)",
      channel: "Demo Studio",
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
      sourceTitle: "GTA VI Stream & Cinema Highlights (Demo)",
      profileId: "cinema-tv-edits",
      status: "done",
      stage: "done",
      progress: 1.0,
      error: null,
      clipCount: 2,
      hypeCurve: DEMO_HYPE,
      createdAt: "2026-11-24T12:00:00Z",
      updatedAt: "2026-11-24T12:01:00Z",
    },
  ];
  private readonly bgmAssets: BgmAssetItem[] = [
    {
      id: "dark_cinema_pulse",
      name: "Dark Cinema Synth Pulse",
      filename: "dark_cinema_pulse.wav",
      mood: "dark_cinema",
      durationMs: 16_000,
      sizeBytes: 2_822_444,
      dropOffsetMs: 0,
      builtin: true,
    },
    {
      id: "upbeat_challenge_drive",
      name: "Upbeat Challenge Drive",
      filename: "upbeat_challenge_drive.wav",
      mood: "upbeat_gaming",
      durationMs: 16_000,
      sizeBytes: 2_822_444,
      dropOffsetMs: 0,
      builtin: true,
    },
  ];
  private readonly projects = new Map<string, TimelineProject>();
  private readonly exports: ExportSummary[] = [];
  private readonly feed: FeedItem[] = [];
  private demoBoundaries =
    "Keep edits snappy; never cut punchlines; preserve dialogue cadence.";
  private demoModels = {
    active_provider: "gemini",
    scan_model: "gemini-2.5-flash",
    editor_model: "gemini-2.5-flash",
  };
  private demoIngest = {
    cookies_browser: "none",
    concurrent_fragments: 8,
  };
  private readonly keysPresent: Record<string, boolean> = {
    gemini: false,
    groq: false,
    openai: false,
    anthropic: false,
    huggingface_token: false,
  };

  constructor() {
    const base = TimelineProjectSchema.parse(sampleEdlFixture);
    // Seed Demo Clip 1: 1:1 Cinema Neon Glow Edit (JJ_EDIT style)
    const cinemaClip: TimelineProject = {
      ...cloneEdl(base),
      projectId: "clip_demo_cinema",
      profileId: "cinema-tv-edits",
      title: "When Reality Hits — Cinema Square Edit",
      output: {
        ...base.output,
        ratio: "1:1",
        borderStyle: "thin_rounded",
        cinemaGrade: "crisp_hd",
      },
      tracks: {
        video: {
          coldOpen: null,
          clips: [
            {
              id: "v1",
              sourceStartMs: 10_000,
              sourceEndMs: 16_000,
              label: "Scene 1 · Opening",
            },
            {
              id: "v2",
              sourceStartMs: 18_500,
              sourceEndMs: 25_000,
              label: "Scene 2 · Realization",
              transitionIn: "flash_white",
              transitionDurationMs: 240,
              transitionSfx: "whoosh_flash",
            },
          ],
          framing: [
            {
              id: "f1",
              timelineStartMs: 0,
              timelineEndMs: 12_500,
              mode: "crop",
              splitRatio: 0.35,
              camBox: null,
              gameBox: null,
              fitBackdrop: "black",
              panX: 0.48,
              panY: 0.42,
              zoom: 1.14,
            },
          ],
        },
        audio: {
          gainDb: 0,
          normalizeLufs: -14,
          dialogueEnhance: true,
          muteOriginal: false,
          bgm: {
            assetId: "dark_cinema_pulse",
            gainDb: -15.5,
            duckingEnabled: true,
            startOffsetMs: 0,
            fadeInMs: 500,
            fadeOutMs: 1000,
          },
        },
        subtitles: {
          enabled: true,
          style: {
            preset: "cinema_neon_glow",
            revealMode: "group",
            font: "Montserrat-ExtraBold",
            fontSizeScale: 1.0,
            primaryColor: "#FFFFFF",
            accentColor: "#4F7CFF",
            outlineColor: "#000000",
            letterSpacing: 3.5,
            colorPalette: ["#4F7CFF", "#4ADE80", "#FBBF24", "#F472B6"],
          },
          censorProfanity: false,
          marginVRatio: 0.38,
          muteRanges: [],
          words: [
            { id: "cw1", text: "Every", startMs: 600, endMs: 1100, speaker: "S1" },
            { id: "cw2", text: "choice", startMs: 1100, endMs: 1650, speaker: "S1" },
            { id: "cw3", text: "leaves", startMs: 1650, endMs: 2200, speaker: "S1" },
            { id: "cw4", text: "a", startMs: 2600, endMs: 2850, speaker: "S1" },
            { id: "cw5", text: "permanent", startMs: 2850, endMs: 3600, speaker: "S1" },
            { id: "cw6", text: "mark.", startMs: 3600, endMs: 4300, speaker: "S1" },
            { id: "cw7", text: "Nothing", startMs: 6400, endMs: 7100, speaker: "S1" },
            { id: "cw8", text: "stays", startMs: 7100, endMs: 7700, speaker: "S1" },
            { id: "cw9", text: "hidden.", startMs: 7700, endMs: 8600, speaker: "S1" },
          ],
        },
        overlays: [
          {
            id: "ov_pov",
            kind: "pov_top_bar",
            text: "POV: WHEN THE SCENE CHANGES EVERYTHING",
            startMs: 0,
            endMs: 3600,
            yAnchor: "top",
            yOffsetRatio: 0,
            maxLines: 2,
          },
          {
            id: "ov_wm",
            kind: "watermark_tag",
            text: "CUTFLOW",
            startMs: 0,
            endMs: 12_500,
            yAnchor: "bottom",
            yOffsetRatio: 0.06,
            xOffsetRatio: 0,
            opacity: 0.78,
            maxLines: 1,
          },
        ],
      },
    };
    this.projects.set(cinemaClip.projectId, cinemaClip);
    this.projects.set(base.projectId, base);
  }

  async health(): Promise<HealthResponse> {
    return {
      status: "ok",
      service: "cutflow-demo",
      version: "0.2.0",
      database: "memory",
      inbox_dir: "~/.cutflow/inbox",
    };
  }

  async listProfiles(): Promise<CreatorProfile[]> {
    return structuredClone(this.profiles);
  }

  async createProfile(input: ProfileCreateInput): Promise<CreatorProfile> {
    const slug =
      input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "creator";
    const created: CreatorProfile = {
      ...this.profiles[0],
      id: slug,
      name: input.name,
      creator_name: input.creator_name ?? "",
      brief: input.brief ?? "",
      content_mode: input.content_mode ?? "stream",
      min_duration_s: input.min_duration_s ?? 15,
      max_duration_s: input.max_duration_s ?? 55,
      max_clips: input.max_clips ?? 8,
      default_ratio: input.default_ratio ?? "9:16",
      layout_mode: input.layout_mode ?? "auto_split",
      border_style: input.border_style ?? "none",
      cinema_grade: input.cinema_grade ?? "off",
      reveal_mode: input.reveal_mode ?? "progressive",
      caption_style: input.caption_style ?? "bold_pop",
      title_card_style: input.title_card_style ?? "seam_card_white",
      watermark_text: input.watermark_text ?? "",
      bgm_mode: input.bgm_mode ?? "off",
      auto_export: input.auto_export ?? false,
      channel_urls: input.channel_urls ?? [],
      keyword_filters: input.keyword_filters ?? [],
      inbox_path: `~/.cutflow/inbox/${slug}`,
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
    camBox: NormalizedBox,
    splitRatio: number,
  ): Promise<CreatorProfile> {
    this.profiles[0].cam_box = camBox;
    this.profiles[0].split_ratio = splitRatio;
    return structuredClone(this.profiles[0]);
  }

  async listSources(): Promise<SourceSummary[]> {
    return structuredClone(this.sources);
  }

  async uploadVideo(
    file: File,
    profileId?: string,
    _subtitleFile?: File | null,
  ): Promise<IngestResult> {
    return this.createDemoIngest("upload", null, file.name, profileId);
  }

  async probeUrl(url: string): Promise<UrlProbeResponse> {
    const lower = url.toLowerCase();
    if (BLOCKED_HOSTS.some((h) => lower.includes(h))) {
      throw new Error(
        "This streaming site uses anti-bot/DRM protection and cannot be downloaded directly. Drop a local .mkv or .mp4 file into CutFlow instead.",
      );
    }
    const isTwitch = lower.includes("twitch.tv");
    const isYoutube = lower.includes("youtube.com") || lower.includes("youtu.be");
    const isKick = lower.includes("kick.com");
    return {
      url,
      platform: isTwitch ? "twitch" : isYoutube ? "youtube" : isKick ? "kick" : "web",
      title: isTwitch
        ? "Twitch Long VOD — Ranked Marathon & Reactions"
        : "Creator Highlight Broadcast VOD",
      channel: isTwitch ? "TwitchCreator" : "StudioChannel",
      durationS: isTwitch ? 14_400 : 3600,
      thumbnailUrl: null,
      isLive: false,
      chapters: isTwitch
        ? [
            { title: "Just Chatting Intro", startS: 0, endS: 1800 },
            { title: "Main Ranked Grind", startS: 1800, endS: 9200 },
            { title: "Final Boss & Reactions", startS: 9200, endS: 14_400 },
          ]
        : [],
    };
  }

  async ingestUrl(
    url: string,
    profileId?: string,
    opts?: UrlIngestOptions,
  ): Promise<IngestResult> {
    const lower = url.toLowerCase();
    if (BLOCKED_HOSTS.some((h) => lower.includes(h))) {
      throw new Error(
        "This streaming site uses anti-bot/DRM protection and cannot be downloaded directly. Drop a local .mkv or .mp4 file into CutFlow instead.",
      );
    }
    const label = opts?.title || url;
    return this.createDemoIngest("url", url, label, opts?.profileId ?? profileId);
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
        score: rank === 1 ? 96 : 92,
        title: edl.title,
        reason:
          edl.output.ratio === "1:1"
            ? "1:1 Cinema Square · Neon Outer Glow · Ducked Synth Pulse"
            : "High-energy reaction climax with clean punchline boundary.",
        status: edl.status,
        totalDurationMs: getTotalDurationMs(edl),
        wordCount: edl.tracks.subtitles.words.length,
        hasSlice: true,
        hasPeaks: true,
        hasThumb: false,
        hasFilmstrip: false,
        createdAt: matchingJob?.createdAt ?? "2026-11-24T12:00:00Z",
        updatedAt: matchingJob?.updatedAt ?? "2026-11-24T12:01:00Z",
      });
      rank += 1;
    }
    return items;
  }

  async createMashup(input: MashupCreateInput): Promise<MashupCreateResponse> {
    if (input.projectIds.length < 2) {
      throw new Error("Select at least 2 clips to compile a mashup.");
    }
    const mashupId = `clip_mashup_${Date.now().toString(36)}`;
    const first =
      this.projects.get(input.projectIds[0]) ??
      this.projects.values().next().value!;
    const merged = cloneEdl(first);
    merged.projectId = mashupId;
    merged.title = input.title?.trim() || "Theme Mashup";
    merged.output.ratio = "1:1";
    merged.output.borderStyle = "thin_rounded";
    merged.output.cinemaGrade = "crisp_hd";
    merged.tracks.video.coldOpen = null;
    merged.tracks.video.clips = input.projectIds.map((pid, idx) => {
      const sub = this.projects.get(pid) ?? first;
      const c0 = sub.tracks.video.clips[0];
      return {
        id: `m${idx + 1}`,
        sourceStartMs: c0.sourceStartMs,
        sourceEndMs: Math.min(c0.sourceEndMs, c0.sourceStartMs + 8000),
        sourceId: sub.sourceId,
        label: sub.title.slice(0, 32),
        transitionIn: idx === 0 ? "none" : (input.transitionStyle ?? "flash_white"),
        transitionDurationMs: 240,
        transitionSfx: idx === 0 ? "none" : (input.transitionSfx ?? "whoosh_flash"),
      };
    });
    const totalMs = getTotalDurationMs(merged);
    merged.tracks.video.framing = [
      {
        ...merged.tracks.video.framing[0],
        timelineStartMs: 0,
        timelineEndMs: totalMs,
      },
    ];
    this.projects.set(mashupId, merged);
    return {
      id: mashupId,
      jobId: "job_demo_001",
      sourceId: merged.sourceId,
      title: merged.title,
      totalDurationMs: totalMs,
      sliceCount: merged.tracks.video.clips.length,
      wordCount: merged.tracks.subtitles.words.length,
      edl: cloneEdl(merged),
    };
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

  projectFilmstripUrl(_projectId: string): string | null {
    return null;
  }

  async listBgm(): Promise<BgmAssetItem[]> {
    return structuredClone(this.bgmAssets);
  }

  async uploadBgm(
    file: File,
    name = "",
    mood = "any",
  ): Promise<BgmAssetItem> {
    const item: BgmAssetItem = {
      id: `bgm_${Date.now().toString(36)}`,
      name: name.trim() || file.name.replace(/\.[^.]+$/, ""),
      filename: file.name,
      mood,
      durationMs: 24_000,
      sizeBytes: file.size || 512_000,
      dropOffsetMs: 2000,
      builtin: false,
    };
    this.bgmAssets.unshift(item);
    return structuredClone(item);
  }

  bgmMediaUrl(_assetId: string): string | null {
    return null;
  }

  async deleteBgm(assetId: string): Promise<void> {
    const idx = this.bgmAssets.findIndex((a) => a.id === assetId && !a.builtin);
    if (idx !== -1) this.bgmAssets.splice(idx, 1);
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

    if (lower.includes("neon glow") || lower.includes("cinema_neon_glow")) {
      next.tracks.subtitles.style.preset = "cinema_neon_glow";
      applied.push("Preset → cinema_neon_glow");
      ops.push({ op: "set_subtitles", preset: "cinema_neon_glow" });
    } else if (lower.includes("punch glow") || lower.includes("viral_punch_glow")) {
      next.tracks.subtitles.style.preset = "viral_punch_glow";
      applied.push("Preset → viral_punch_glow");
      ops.push({ op: "set_subtitles", preset: "viral_punch_glow" });
    }

    if (lower.includes("1:1") || lower.includes("square")) {
      next.output.ratio = "1:1";
      next.output.borderStyle = "thin_rounded";
      applied.push("Output → 1:1 Cinema Square");
      ops.push({ op: "set_output", ratio: "1:1", borderStyle: "thin_rounded" });
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
      (lower.includes("insert") ||
        lower.includes("add word") ||
        lower.includes("add '") ||
        lower.includes('add "')) &&
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

    if (
      /\b(?:remove|delete|hide|clear|drop)\b.*\b(?:hook|headline|overlay|banner|card|title|watermark)\b/i.test(
        text,
      )
    ) {
      const selOvId = req.selection?.selectedOverlayId;
      const beforeCount = next.tracks.overlays.length;
      if (selOvId && next.tracks.overlays.some((o) => o.id === selOvId)) {
        next.tracks.overlays = next.tracks.overlays.filter((o) => o.id !== selOvId);
      } else if (lower.includes("hook") || lower.includes("headline")) {
        const filtered = next.tracks.overlays.filter(
          (o) =>
            o.kind !== "seam_card_white" &&
            o.kind !== "hook_banner_dark" &&
            !o.text.toLowerCase().includes("hook"),
        );
        next.tracks.overlays =
          filtered.length < beforeCount ? filtered : next.tracks.overlays.slice(1);
      } else {
        next.tracks.overlays = [];
      }
      if (next.tracks.overlays.length < beforeCount) {
        applied.push(
          `Removed ${beforeCount - next.tracks.overlays.length} overlay(s)`,
        );
        ops.push({ op: "delete_overlay" });
      }
      if (lower.includes("hook") && next.tracks.video.coldOpen?.enabled) {
        next.tracks.video.coldOpen = null;
        applied.push("Cold-open → off");
      }
    }

    if (/\bmute\b.*\b(?:voice|audio|dialogue|original)\b/i.test(text)) {
      next.tracks.audio.gainDb = -60;
      next.tracks.audio.muteOriginal = true;
      applied.push("Dialogue audio → muted (-∞ dB)");
      ops.push({ op: "set_audio", gainDb: -60, muteOriginal: true });
    }

    const speedMatch = text.match(/\b(\d+(?:\.\d+)?)\s*x\b/i);
    if (speedMatch && (lower.includes("speed") || lower.includes("faster") || lower.includes("slow"))) {
      const spd = Math.max(0.25, Math.min(4, parseFloat(speedMatch[1])));
      const targetId = req.selection?.selectedClipId ?? next.tracks.video.clips[0]?.id;
      const clip = next.tracks.video.clips.find((c) => c.id === targetId);
      if (clip) {
        clip.speed = spd;
        const newTotal = getTotalDurationMs(next);
        if (next.tracks.video.framing.length > 0) {
          next.tracks.video.framing[next.tracks.video.framing.length - 1].timelineEndMs =
            newTotal;
        }
        applied.push(`Clip speed → ${spd}×`);
        ops.push({ op: "set_clip_speed", clipId: clip.id, speed: spd });
      }
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
          : 'Try commands like "Remove the hook", "Speed up 1.5x", "Mute voice", "cut 4s to 7s", or "1:1 square".',
      provider: "demo-rules",
      modelUsed: req.model ? `demo:${req.model}` : "demo-rules",
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
    const hashtags = ["#clips", "#shorts", "#cinema", "#edit", "#viral", "#fyp"];
    const description = `${title} — watch until the final cut.`;
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
    return this.ingestUrl(`https://www.youtube.com/watch?v=${feedId}`);
  }

  async dismissFeedItem(feedId: string): Promise<void> {
    const found = this.feed.find((f) => f.id === feedId);
    if (found) found.status = "dismissed";
  }

  async getSettings(): Promise<SettingsResponse> {
    return {
      settings: {
        models: { ...this.demoModels },
        ingest: { ...this.demoIngest },
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
    const ing = patch.ingest as
      | { cookies_browser?: string; concurrent_fragments?: number }
      | undefined;
    if (ing) {
      this.demoIngest = {
        cookies_browser: ing.cookies_browser ?? this.demoIngest.cookies_browser,
        concurrent_fragments:
          ing.concurrent_fragments ?? this.demoIngest.concurrent_fragments,
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
      version: "0.2.0",
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
      inboxRoot: "~/.cutflow/inbox",
    };
  }

  async setSecret(key: string, _value: string): Promise<void> {
    this.keysPresent[key] = true;
  }

  async deleteSecret(key: string): Promise<void> {
    this.keysPresent[key] = false;
  }

  async importLocalPath(
    localPath: string,
    opts?: LocalPathImportOptions,
  ): Promise<IngestResult> {
    const cleanName = localPath.split(/[\\/]/).pop() ?? "local_media.mp4";
    const title = opts?.title?.trim() || cleanName.replace(/\.[^.]+$/, "");
    const src: SourceSummary = {
      id: `src_local_${Date.now().toString(36)}`,
      sourceType: "local",
      url: null,
      title,
      channel: "Local Disk",
      durationMs: 30_000,
      width: 1920,
      height: 1080,
      fps: 60,
      archived: false,
      createdAt: new Date().toISOString(),
    };
    this.sources.unshift(src);
    return { source: src, job: null };
  }

  sourceMediaUrl(_sourceId: string): string | null {
    return null;
  }

  async listSfx(): Promise<SfxAssetItem[]> {
    return [
      { id: "whoosh_flash", name: "Whoosh Flash Transition", durationMs: 420, sizeBytes: 75_000 },
      { id: "cinema_hit", name: "Cinema Sub Impact Hit", durationMs: 900, sizeBytes: 158_000 },
    ];
  }

  sfxMediaUrl(_sfxId: string): string | null {
    return null;
  }

  async createBlankProject(
    input?: BlankProjectCreateInput,
  ): Promise<BlankProjectCreateResponse> {
    await this.listProjects();
    const id = `clip_blank_${Date.now().toString(36)}`;
    const title = input?.title?.trim() || "Untitled Project";
    const ratio = input?.ratio ?? "9:16";
    const srcId = input?.sourceId ?? this.sources[0]?.id ?? "src_demo_001";
    const now = new Date().toISOString();
    const edl: TimelineProject = TimelineProjectSchema.parse({
      schemaVersion: 1,
      projectId: id,
      sourceId: srcId,
      profileId: input?.profileId ?? this.profiles[0]?.id ?? null,
      title,
      status: "draft",
      sourceDurationMs: 15_000,
      sourceWidth: 1920,
      sourceHeight: 1080,
      output: {
        ratio,
        quality: "1080p",
        speedPreset: "final",
        fps: 60,
        loudnessLufs: -14,
        borderStyle: "none",
        cinemaGrade: "off",
      },
      tracks: {
        video: {
          coldOpen: null,
          clips: [
            {
              id: "s1",
              sourceStartMs: 0,
              sourceEndMs: 15_000,
              sourceId: srcId,
              label: title,
            },
          ],
          framing: [
            {
              id: "f1",
              timelineStartMs: 0,
              timelineEndMs: 15_000,
              mode: "fit",
              splitRatio: 0.35,
              camBox: null,
              gameBox: null,
              fitBackdrop: "black",
            },
          ],
          broll: [],
        },
        audio: {
          gainDb: 0,
          normalizeLufs: -14,
          dialogueEnhance: false,
          muteOriginal: false,
          bgm: null,
          clips: [],
        },
        subtitles: {
          enabled: true,
          style: {
            preset: "bold_pop",
            revealMode: "progressive",
            font: "Montserrat-ExtraBold",
            fontSizeScale: 1,
            primaryColor: "#FFFFFF",
            accentColor: "#FFE500",
            outlineColor: "#000000",
          },
          censorProfanity: false,
          marginVRatio: 0.22,
          muteRanges: [],
          words: [],
        },
        overlays: [],
      },
    });
    this.projects.set(id, cloneEdl(edl));
    return {
      id,
      jobId: "job_demo_001",
      sourceId: srcId,
      title,
      totalDurationMs: 15_000,
      edl: cloneEdl(edl),
      createdAt: now,
      updatedAt: now,
    };
  }

  async renameProject(
    projectId: string,
    patch: { title?: string; status?: ClipStatus },
  ): Promise<ClipProjectSummary> {
    const found = this.projects.get(projectId);
    if (!found) throw new Error(`Project '${projectId}' not found.`);
    if (patch.title !== undefined && patch.title.trim()) {
      found.title = patch.title.trim();
    }
    if (patch.status) {
      found.status = patch.status;
    }
    const list = await this.listProjects();
    const item = list.find((p) => p.id === projectId);
    if (!item) throw new Error(`Project '${projectId}' not found.`);
    return item;
  }

  async duplicateProject(projectId: string): Promise<ClipProjectSummary> {
    const found = this.projects.get(projectId);
    if (!found) throw new Error(`Project '${projectId}' not found.`);
    const newId = `${projectId}_copy_${Date.now().toString(36)}`;
    const copy = cloneEdl(found);
    copy.projectId = newId;
    copy.title = `${found.title || "Project"} (Copy)`;
    this.projects.set(newId, copy);
    const list = await this.listProjects();
    return list.find((p) => p.id === newId)!;
  }

  async deleteProject(projectId: string): Promise<void> {
    this.projects.delete(projectId);
  }

  async transcribeProject(
    projectId: string,
    language = "en",
  ): Promise<TranscribeProjectResponse> {
    const found = this.projects.get(projectId);
    if (!found) throw new Error(`Project '${projectId}' not found.`);
    const before = cloneEdl(found);
    const next = cloneEdl(found);
    if (next.tracks.subtitles.words.length === 0) {
      const sampleTokens = ["WAIT", "FOR", "THIS", "MOMENT", "RIGHT", "HERE!"];
      const total = getTotalDurationMs(next);
      const step = Math.max(250, Math.floor(Math.min(total, 3600) / sampleTokens.length));
      next.tracks.subtitles.words = sampleTokens.map((t, idx) => ({
        id: `dw_${idx + 1}`,
        text: t,
        startMs: idx * step + 80,
        endMs: (idx + 1) * step,
        speaker: "S1",
      }));
      next.tracks.subtitles.enabled = true;
      this.projects.set(projectId, cloneEdl(next));
    }
    return {
      edl: cloneEdl(next),
      previousEdl: before,
      wordCount: next.tracks.subtitles.words.length,
      provider: "demo:whisper-small-int8",
      language: language || "en",
      totalDurationMs: getTotalDurationMs(next),
    };
  }

  async listAiModels(): Promise<AiModelsResponse> {
    return {
      activeProvider: this.demoModels.active_provider,
      scanModel: this.demoModels.scan_model,
      editorModel: this.demoModels.editor_model,
      keysPresent: { ...this.keysPresent },
      ollamaOnline: false,
      modelsByProvider: {
        gemini: ["gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.1-flash-lite"],
        openai: ["gpt-4o-mini", "gpt-4.1-mini"],
        anthropic: ["claude-sonnet-4-5"],
        groq: ["llama-3.3-70b-versatile"],
        ollama: ["qwen2.5:7b"],
      },
    };
  }
}
