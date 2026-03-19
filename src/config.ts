import { z } from "zod";

const clipRenderModeSchema = z.enum(["reel", "source"]);
const captionOutputModeSchema = z.enum(["burned", "sidecar", "both", "none"]);

export type ClipRenderMode = z.infer<typeof clipRenderModeSchema>;
export type CaptionOutputMode = z.infer<typeof captionOutputModeSchema>;

const configSchema = z
  .object({
    geminiApiKey: z.string().min(1),
    whisperModel: z.enum(["tiny", "base", "small", "medium", "large"]).default("base"),
    whisperCliPath: z.string().default("whisper-cli"),
    maxParallelClips: z.coerce.number().int().min(1).max(10).default(3),
    silenceThresholdDb: z.coerce.number().default(-35),
    silenceMinDuration: z.coerce.number().default(0.8),
    outputWidth: z.coerce.number().default(1080),
    outputHeight: z.coerce.number().default(1920),
    clipSpeed: z.coerce.number().min(1).max(2).default(1.2),
    maxClips: z.coerce.number().int().min(0).default(0),
    preferYouTubeTranscripts: z.coerce.boolean().default(true),
    captionAnimate: z.coerce.boolean().default(true),
    clipRenderMode: clipRenderModeSchema.default("reel"),
    captionOutput: captionOutputModeSchema.default("burned"),
    cookiesFromBrowser: z.string().optional().default(""),
    paths: z
      .object({
        data: z.string().default("./data"),
        output: z.string().default("./output"),
        assets: z.string().default("./assets"),
        subwaySurfers: z.string().default("./assets/subway-surfers"),
        checkpointDb: z.string().default("./data/checkpoints.db"),
      })
      .default({}),
  })
  .superRefine((value, ctx) => {
    if (
      value.clipRenderMode === "source" &&
      (value.captionOutput === "burned" || value.captionOutput === "both")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["captionOutput"],
        message: "Source clip output only supports sidecar or none caption output.",
      });
    }
  });

export type Config = z.infer<typeof configSchema>;

export interface ConfigOverrides {
  clipRenderMode?: ClipRenderMode;
  captionOutput?: CaptionOutputMode;
}

export function loadConfig(overrides: ConfigOverrides = {}): Config {
  return configSchema.parse({
    geminiApiKey: Bun.env.GEMINI_API_KEY,
    whisperModel: Bun.env.WHISPER_MODEL,
    whisperCliPath: Bun.env.WHISPER_CLI_PATH,
    maxParallelClips: Bun.env.MAX_PARALLEL_CLIPS,
    silenceThresholdDb: Bun.env.SILENCE_THRESHOLD_DB,
    silenceMinDuration: Bun.env.SILENCE_MIN_DURATION,
    outputWidth: Bun.env.OUTPUT_WIDTH,
    outputHeight: Bun.env.OUTPUT_HEIGHT,
    clipSpeed: Bun.env.CLIP_SPEED,
    maxClips: Bun.env.MAX_CLIPS,
    preferYouTubeTranscripts: Bun.env.PREFER_YOUTUBE_TRANSCRIPTS,
    captionAnimate: Bun.env.CAPTION_ANIMATE,
    clipRenderMode: Bun.env.CLIP_RENDER_MODE,
    captionOutput: Bun.env.CAPTION_OUTPUT,
    cookiesFromBrowser: Bun.env.YT_DLP_COOKIES_FROM_BROWSER,
    paths: {},
    ...overrides,
  });
}
