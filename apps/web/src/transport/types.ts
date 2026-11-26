import type { BgmTrack, NormalizedBox, TimelineProject, VideoSlice } from "../edl";

export interface HealthResponse {
  status: string;
  service: string;
  version: string;
  database: string;
  inbox_dir: string;
}

export interface CreatorProfile {
  id: string;
  name: string;
  creator_name: string;
  brief: string;
  content_mode?: string;
  preferred_lang?: string;
  min_duration_s: number;
  max_duration_s: number;
  max_clips: number;
  default_ratio?: string;
  layout_mode: string;
  fit_backdrop?: string;
  split_ratio: number;
  border_style?: string;
  cinema_grade?: string;
  title_card_style: string;
  cold_open_enabled: boolean;
  cold_open_duration_ms: number;
  cta_mode: string;
  cta_text: string;
  watermark_text?: string;
  watermark_opacity?: number;
  show_cinema_credit?: boolean;
  transition_style?: string;
  transition_sfx?: string;
  bgm_mode?: string;
  bgm_mood?: string;
  bgm_asset_id?: string;
  dialogue_enhance?: boolean;
  auto_tighten_silence?: boolean;
  reveal_mode: string;
  caption_style: string;
  burn_captions: boolean;
  censor_profanity: boolean;
  margin_v_ratio?: number;
  editor_boundaries: string;
  channel_urls: string[];
  keyword_filters: string[];
  auto_queue_feed: boolean;
  auto_export: boolean;
  inbox_path: string;
  cam_box?: NormalizedBox | null;
}

export interface ProfileCreateInput {
  name: string;
  creator_name?: string;
  brief?: string;
  content_mode?: string;
  preferred_lang?: string;
  min_duration_s?: number;
  max_duration_s?: number;
  max_clips?: number;
  default_ratio?: string;
  layout_mode?: string;
  fit_backdrop?: string;
  border_style?: string;
  cinema_grade?: string;
  title_card_style?: string;
  cold_open_enabled?: boolean;
  watermark_text?: string;
  show_cinema_credit?: boolean;
  transition_style?: string;
  transition_sfx?: string;
  bgm_mode?: string;
  bgm_mood?: string;
  bgm_asset_id?: string;
  dialogue_enhance?: boolean;
  auto_tighten_silence?: boolean;
  reveal_mode?: string;
  caption_style?: string;
  margin_v_ratio?: number;
  auto_export?: boolean;
  channel_urls?: string[];
  keyword_filters?: string[];
}

export interface SourceSummary {
  id: string;
  sourceType: string;
  url: string | null;
  title: string;
  channel: string | null;
  durationMs: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  archived: boolean;
  createdAt: string;
}

export interface UrlProbeChapter {
  title: string;
  startS: number;
  endS: number;
}

export interface UrlProbeResponse {
  url: string;
  platform: string;
  title: string;
  channel: string;
  durationS: number;
  thumbnailUrl: string | null;
  isLive: boolean;
  chapters: UrlProbeChapter[];
}

export interface UrlIngestOptions {
  profileId?: string;
  title?: string;
  startSec?: number;
  endSec?: number;
}

export interface HypeCurvePoint {
  startS: number;
  endS: number;
  score: number;
}

export interface JobSummary {
  id: string;
  sourceId: string;
  sourceTitle: string;
  profileId: string | null;
  status: "queued" | "running" | "done" | "failed" | string;
  stage: string;
  progress: number;
  error: string | null;
  downloadDetail?: string | null;
  clipCount: number;
  hypeCurve: HypeCurvePoint[];
  createdAt: string;
  updatedAt: string;
}

export interface JobProgressEvent {
  jobId: string;
  sourceId: string;
  profileId: string | null;
  status: string;
  stage: string;
  progress: number;
  error: string | null;
  detail?: string;
  hypeCurve?: HypeCurvePoint[];
  clipsCreated?: number;
  projectIds?: string[];
}

export interface ClipProjectSummary {
  id: string;
  jobId: string;
  sourceId: string;
  rank: number;
  score: number;
  title: string;
  reason: string;
  status: string;
  totalDurationMs: number;
  wordCount: number;
  hasSlice: boolean;
  hasPeaks: boolean;
  hasThumb: boolean;
  hasFilmstrip?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MashupCreateInput {
  projectIds: string[];
  title?: string;
  povHook?: string;
  profileId?: string;
  transitionStyle?: NonNullable<VideoSlice["transitionIn"]>;
  transitionSfx?: NonNullable<VideoSlice["transitionSfx"]>;
  maxSliceDurationMs?: number;
}

export interface MashupCreateResponse {
  id: string;
  jobId: string;
  sourceId: string;
  title: string;
  totalDurationMs: number;
  sliceCount: number;
  wordCount: number;
  edl: TimelineProject;
}

export interface BgmAssetItem {
  id: string;
  name: string;
  filename: string;
  mood: string;
  durationMs: number;
  sizeBytes: number;
  dropOffsetMs: number;
  builtin: boolean;
}

export interface IngestResult {
  source: SourceSummary;
  job: JobSummary | null;
}

export interface StorageSummary {
  root: string;
  mediaBytes: number;
  workBytes: number;
  exportsBytes: number;
  cacheBytes: number;
  diskFreeBytes: number;
  diskTotalBytes: number;
}

export interface FeedItem {
  id: string;
  profileId: string;
  externalId: string;
  url: string;
  title: string;
  channel: string;
  durationS: number;
  thumbnailUrl: string | null;
  status: string;
  discoveredAt: string;
}

export interface TimelineResponse {
  edl: TimelineProject;
  totalDurationMs: number;
  sliceOriginMs?: number;
}

export interface ProjectPeaks {
  rateHz: number;
  durationMs: number;
  peaks: number[];
  rms: number[];
}

export interface ExportSummary {
  id: string;
  projectId: string;
  title: string;
  ratio: string;
  quality: string;
  speedPreset: string;
  sizeBytes: number;
  durationMs: number;
  encoder?: string;
  createdAt: string;
}

export interface ExportRequestOptions {
  ratio?: "9:16" | "4:5" | "1:1" | "16:9";
  quality?: "720p" | "1080p" | "1440p" | "4k";
  speedPreset?: "draft" | "final";
}

export interface CoEditorRequest {
  instruction: string;
  boundaries?: string;
  playheadMs?: number;
  saveBoundaries?: boolean;
}

export interface CoEditorResponse {
  edl: TimelineProject;
  previousEdl: TimelineProject;
  applied: string[];
  ops: Record<string, unknown>[];
  reply: string;
  provider: string;
  boundaries: string;
  totalDurationMs: number;
}

export type ClipStatus = "draft" | "approved" | "exported" | "posted" | "archived";

export interface PostCopyResponse {
  platform: string;
  title: string;
  description: string;
  hashtags: string[];
  fullCopy: string;
  provider: string;
}

export interface SettingsResponse {
  settings: Record<string, unknown>;
  keys_present: Record<string, boolean>;
}

export interface DoctorReport {
  version: string;
  platform: string;
  python: string;
  ffmpeg: string;
  libass: boolean;
  ytDlp: boolean;
  gpu: string;
  nvencOk: boolean;
  nvencDetail: string;
  dataRoot: string;
  freeGb: number;
  inboxRoot: string;
}

export type BgmPatch = Partial<BgmTrack> & { enabled?: boolean };

/**
 * Clean transport abstraction enabling the exact same CutFlow Studio UI to talk
 * to local FastAPI (`HttpTransport`) or run in zero-cost browser Demo Mode (`DemoTransport`).
 */
export interface StudioTransport {
  readonly mode: "local" | "demo";
  health(): Promise<HealthResponse>;
  listProfiles(): Promise<CreatorProfile[]>;
  createProfile(input: ProfileCreateInput): Promise<CreatorProfile>;
  updateProfile(profileId: string, patch: Record<string, unknown>): Promise<CreatorProfile>;
  deleteProfile(profileId: string): Promise<void>;
  pinWebcamToProfile(
    projectId: string,
    camBox: NormalizedBox,
    splitRatio: number,
  ): Promise<CreatorProfile>;
  listSources(): Promise<SourceSummary[]>;
  uploadVideo(
    file: File,
    profileId?: string,
    subtitleFile?: File | null,
  ): Promise<IngestResult>;
  probeUrl(url: string): Promise<UrlProbeResponse>;
  ingestUrl(
    url: string,
    profileId?: string,
    opts?: UrlIngestOptions,
  ): Promise<IngestResult>;
  archiveSource(
    sourceId: string,
  ): Promise<{ sourceId: string; archived: boolean; reclaimedBytes: number }>;
  getStorageSummary(): Promise<StorageSummary>;
  listJobs(): Promise<JobSummary[]>;
  subscribeJobEvents(
    jobId: string,
    onEvent: (evt: JobProgressEvent) => void,
  ): () => void;
  listProjects(jobId?: string): Promise<ClipProjectSummary[]>;
  createMashup(input: MashupCreateInput): Promise<MashupCreateResponse>;
  getTimeline(projectId: string): Promise<TimelineResponse>;
  saveTimeline(projectId: string, edl: TimelineProject): Promise<TimelineResponse>;
  getProjectPeaks(projectId: string): Promise<ProjectPeaks>;
  projectMediaUrl(projectId: string): string | null;
  projectThumbUrl(projectId: string): string | null;
  projectFilmstripUrl(projectId: string): string | null;
  listBgm(): Promise<BgmAssetItem[]>;
  uploadBgm(file: File, name?: string, mood?: string): Promise<BgmAssetItem>;
  bgmMediaUrl(assetId: string): string | null;
  deleteBgm(assetId: string): Promise<void>;
  exportProject(
    projectId: string,
    opts?: ExportRequestOptions,
  ): Promise<ExportSummary>;
  runCoEditor(
    projectId: string,
    req: CoEditorRequest,
  ): Promise<CoEditorResponse>;
  updateProjectStatus(
    projectId: string,
    status: ClipStatus,
  ): Promise<ClipProjectSummary>;
  generatePostCopy(
    projectId: string,
    platform?: "tiktok" | "shorts" | "reels" | "all",
  ): Promise<PostCopyResponse>;
  listExports(projectId?: string): Promise<ExportSummary[]>;
  exportDownloadUrl(exportId: string): string | null;
  deleteExport(exportId: string): Promise<void>;
  scanInbox(profileId?: string): Promise<{ count: number }>;
  listFeed(): Promise<FeedItem[]>;
  pollFeed(): Promise<{ count: number }>;
  clipFeedItem(feedId: string): Promise<IngestResult>;
  dismissFeedItem(feedId: string): Promise<void>;
  getSettings(): Promise<SettingsResponse>;
  saveSettings(patch: Record<string, unknown>): Promise<SettingsResponse>;
  getDoctor(): Promise<DoctorReport>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}
