import { z } from "zod";

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export const NormalizedBoxSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0.05).max(1),
    h: z.number().min(0.05).max(1),
  })
  .strict();

export const OutputSettingsSchema = z
  .object({
    ratio: z.enum(["9:16", "4:5", "1:1", "16:9"]),
    quality: z.enum(["720p", "1080p", "1440p", "4k"]),
    speedPreset: z.enum(["draft", "final"]),
    fps: z.number().int().min(15).max(120),
    loudnessLufs: z.number().min(-36).max(-5),
    borderStyle: z.enum(["none", "thin_rounded", "double_cinema"]).optional(),
    cinemaGrade: z.enum(["off", "crisp_hd"]).optional(),
  })
  .strict();

export const ColdOpenBlockSchema = z
  .object({
    enabled: z.boolean(),
    sourceStartMs: z.number().int().min(0),
    durationMs: z.number().int().min(500).max(4000),
    fadeOutMs: z.number().int().min(0).max(500).default(120),
  })
  .strict();

export const VideoSliceSchema = z
  .object({
    id: z.string().min(1),
    sourceStartMs: z.number().int().min(0),
    sourceEndMs: z.number().int().min(1),
    sourceId: z.string().nullable().optional(),
    label: z.string().optional(),
    timelineStartMs: z.number().int().min(0).nullable().optional(),
    speed: z.number().min(0.25).max(4.0).optional(),
    reverse: z.boolean().optional(),
    freezeDurationMs: z.number().int().min(0).max(30000).optional(),
    gainDb: z.number().min(-60).max(12).optional(),
    muted: z.boolean().optional(),
    audioDetached: z.boolean().optional(),
    fadeInMs: z.number().int().min(0).max(5000).optional(),
    fadeOutMs: z.number().int().min(0).max(5000).optional(),
    transitionIn: z.enum(["none", "flash_white", "dip_black", "dissolve"]).optional(),
    transitionDurationMs: z.number().int().min(80).max(800).optional(),
    transitionSfx: z.enum(["none", "whoosh_flash", "cinema_hit"]).optional(),
  })
  .strict()
  .refine((v) => v.sourceEndMs > v.sourceStartMs, {
    message: "sourceEndMs must be greater than sourceStartMs",
  });

export const BRollClipSchema = z
  .object({
    id: z.string().min(1),
    sourceId: z.string().min(1),
    label: z.string().optional(),
    sourceStartMs: z.number().int().min(0),
    sourceEndMs: z.number().int().min(1),
    timelineStartMs: z.number().int().min(0),
    speed: z.number().min(0.25).max(4.0).optional(),
    opacity: z.number().min(0.1).max(1.0).optional(),
    box: NormalizedBoxSchema.nullable().optional(),
    gainDb: z.number().min(-60).max(12).optional(),
    muted: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.sourceEndMs > b.sourceStartMs, {
    message: "broll sourceEndMs must be greater than sourceStartMs",
  });

export const FramingSegmentSchema = z
  .object({
    id: z.string().min(1),
    timelineStartMs: z.number().int().min(0),
    timelineEndMs: z.number().int().min(1),
    mode: z.enum(["split", "fit", "centre", "crop"]),
    splitRatio: z.number().min(0.2).max(0.65).default(0.35),
    camBox: NormalizedBoxSchema.nullable().default(null),
    gameBox: NormalizedBoxSchema.nullable().default(null),
    fitBackdrop: z.enum(["blur", "black"]).optional(),
    panX: z.number().min(0).max(1).optional(),
    panY: z.number().min(0).max(1).optional(),
    zoom: z.number().min(1.0).max(2.5).optional(),
    sourceCropBox: NormalizedBoxSchema.nullable().optional(),
  })
  .strict()
  .refine((f) => f.timelineEndMs > f.timelineStartMs, {
    message: "timelineEndMs must be greater than timelineStartMs",
  });

export const VideoTrackSchema = z
  .object({
    coldOpen: ColdOpenBlockSchema.nullable().default(null),
    clips: z.array(VideoSliceSchema).min(1),
    framing: z.array(FramingSegmentSchema).min(1),
    broll: z.array(BRollClipSchema).optional(),
  })
  .strict();

export const BgmConfigSchema = z
  .object({
    assetId: z.string().optional(),
    gainDb: z.number().min(-60).max(12).default(-16),
    duckingEnabled: z.boolean().default(true),
    startOffsetMs: z.number().int().min(0).optional(),
    fadeInMs: z.number().int().min(0).max(5000).optional(),
    fadeOutMs: z.number().int().min(0).max(5000).optional(),
  })
  .strict();

export const AudioClipItemSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["detached", "sfx", "audio"]).optional(),
    assetId: z.string().nullable().optional(),
    sourceId: z.string().nullable().optional(),
    label: z.string().optional(),
    sourceStartMs: z.number().int().min(0),
    sourceEndMs: z.number().int().min(1),
    timelineStartMs: z.number().int().min(0),
    speed: z.number().min(0.25).max(4.0).optional(),
    gainDb: z.number().min(-60).max(12).optional(),
    muted: z.boolean().optional(),
    fadeInMs: z.number().int().min(0).max(5000).optional(),
    fadeOutMs: z.number().int().min(0).max(5000).optional(),
  })
  .strict()
  .refine((a) => a.sourceEndMs > a.sourceStartMs, {
    message: "audio clip sourceEndMs must be greater than sourceStartMs",
  });

export const AudioTrackSchema = z
  .object({
    gainDb: z.number().min(-60).max(24).default(0),
    normalizeLufs: z.number().min(-36).max(-5).default(-14),
    dialogueEnhance: z.boolean().optional(),
    muteOriginal: z.boolean().optional(),
    bgm: BgmConfigSchema.nullable().default(null),
    clips: z.array(AudioClipItemSchema).optional(),
  })
  .strict();

export const SubtitleStyleSchema = z
  .object({
    preset: z.enum([
      "bold_pop",
      "karaoke_fill",
      "clean_lower",
      "boxed",
      "cinema_neon_glow",
      "viral_punch_glow",
    ]),
    revealMode: z.enum(["group", "progressive", "single_word"]),
    font: z.string().min(1),
    fontSizeScale: z.number().min(0.5).max(2.0),
    primaryColor: z.string().regex(HEX_COLOR, "Expected #RRGGBB hex color"),
    accentColor: z.string().regex(HEX_COLOR, "Expected #RRGGBB hex color"),
    outlineColor: z.string().regex(HEX_COLOR, "Expected #RRGGBB hex color"),
    letterSpacing: z.number().min(0).max(12).optional(),
    colorPalette: z.array(z.string().regex(HEX_COLOR)).optional(),
  })
  .strict();

export const SubtitleWordSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(1),
    speaker: z.string().nullable().default(null),
    glowColor: z.string().regex(HEX_COLOR).nullable().optional(),
  })
  .strict()
  .refine((w) => w.endMs > w.startMs, {
    message: "word endMs must be greater than startMs",
  });

export const MuteRangeSchema = z
  .tuple([z.number().int().min(0), z.number().int().min(1)])
  .refine(([s, e]) => e > s, {
    message: "muteRange endMs must be greater than startMs",
  });

export const SubtitleTrackSchema = z
  .object({
    enabled: z.boolean(),
    style: SubtitleStyleSchema,
    censorProfanity: z.boolean(),
    marginVRatio: z.number().min(0.05).max(0.85),
    muteRanges: z.array(MuteRangeSchema),
    words: z.array(SubtitleWordSchema),
  })
  .strict();

export const OverlayItemSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum([
      "seam_card_white",
      "hook_banner_dark",
      "cta_pill",
      "pov_top_bar",
      "watermark_tag",
      "cinema_credit",
    ]),
    text: z.string(),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(1),
    yAnchor: z.enum(["split_seam", "top", "bottom"]).default("split_seam"),
    yOffsetRatio: z.number().min(-0.5).max(0.5).default(0),
    xOffsetRatio: z.number().min(-0.5).max(0.5).optional(),
    opacity: z.number().min(0.1).max(1.0).optional(),
    scale: z.number().min(0.4).max(2.5).optional(),
    maxLines: z.number().int().min(1).max(4).default(2),
  })
  .strict()
  .refine((o) => o.endMs > o.startMs, {
    message: "overlay endMs must be greater than startMs",
  });

export const TracksSchema = z
  .object({
    video: VideoTrackSchema,
    audio: AudioTrackSchema,
    subtitles: SubtitleTrackSchema,
    overlays: z.array(OverlayItemSchema),
  })
  .strict();

export const TimelineProjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().min(1),
    sourceId: z.string().min(1),
    profileId: z.string().nullable().default(null),
    title: z.string().default(""),
    status: z
      .enum(["draft", "approved", "exported", "posted", "archived"])
      .default("draft"),
    sourceDurationMs: z.number().int().min(0).default(0),
    sourceWidth: z.number().int().min(2).default(1920),
    sourceHeight: z.number().int().min(2).default(1080),
    output: OutputSettingsSchema,
    tracks: TracksSchema,
  })
  .strict();

export type NormalizedBox = z.infer<typeof NormalizedBoxSchema>;
export type OutputSettings = z.infer<typeof OutputSettingsSchema>;
export type ColdOpenBlock = z.infer<typeof ColdOpenBlockSchema>;
export type VideoSlice = z.infer<typeof VideoSliceSchema>;
export type BRollClip = z.infer<typeof BRollClipSchema>;
export type FramingSegment = z.infer<typeof FramingSegmentSchema>;
export type BgmConfig = z.infer<typeof BgmConfigSchema>;
export type BgmTrack = BgmConfig;
export type AudioClipItem = z.infer<typeof AudioClipItemSchema>;
export type AudioTrack = z.infer<typeof AudioTrackSchema>;
export type SubtitleStyle = z.infer<typeof SubtitleStyleSchema>;
export type SubtitleWord = z.infer<typeof SubtitleWordSchema>;
export type OverlayItem = z.infer<typeof OverlayItemSchema>;
export type TimelineProject = z.infer<typeof TimelineProjectSchema>;
