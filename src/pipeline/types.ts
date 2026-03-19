export enum PipelineStage {
  DOWNLOAD = "DOWNLOAD",
  TRANSCRIBE = "TRANSCRIBE",
  IDENTIFY_CLIPS = "IDENTIFY_CLIPS",
  EXTRACT_CLIPS = "EXTRACT_CLIPS",
  REMOVE_SILENCE = "REMOVE_SILENCE",
  GENERATE_CAPTIONS = "GENERATE_CAPTIONS",
  COMPOSE_REEL = "COMPOSE_REEL",
}

export enum StageStatus {
  PENDING = "pending",
  IN_PROGRESS = "in_progress",
  COMPLETED = "completed",
  FAILED = "failed",
  SKIPPED = "skipped",
}

export interface PipelineRun {
  id: string;
  videoUrl: string;
  videoId: string;
  videoTitle: string;
  createdAt: string;
  updatedAt: string;
  currentStage: PipelineStage;
  status: "running" | "paused" | "completed" | "failed";
}

export interface StageResult<T = unknown> {
  stage: PipelineStage;
  status: StageStatus;
  startedAt: string;
  completedAt: string | null;
  artifactPaths: string[];
  data: T;
  error: string | null;
}

export interface VideoMetadata {
  videoId: string;
  title: string;
  duration: number;
  uploadDate: string;
  filePath: string;
}

export interface TranscriptSegment {
  text: string;
  start: number;
  duration: number;
  end: number;
}

export interface Transcript {
  source: "whisper" | "youtube" | "deepgram";
  language: string;
  segments: TranscriptSegment[];
  fullText: string;
  srtPath: string | null;
}

export interface ClipCandidate {
  id: string;
  title: string;
  hookLine: string;
  startTime: number;
  endTime: number;
  duration: number;
  reasoning: string;
  viralScore: number;
  tags: string[];
}

export interface ClipArtifacts {
  clipId: string;
  extractedVideoPath: string;
  exportedVideoPath: string;
  silenceRemovedPath?: string;
  captionSrtPath?: string;
  captionOverlayPath?: string;
  finalReelPath?: string;
}

export interface SilenceRange {
  start: number;
  end: number;
}

export interface FfprobeResult {
  duration: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string;
  fps: number;
}

export const GLOBAL_STAGES = [
  PipelineStage.DOWNLOAD,
  PipelineStage.TRANSCRIBE,
  PipelineStage.IDENTIFY_CLIPS,
] as const;

export const CLIP_STAGES = [
  PipelineStage.EXTRACT_CLIPS,
  PipelineStage.REMOVE_SILENCE,
  PipelineStage.GENERATE_CAPTIONS,
  PipelineStage.COMPOSE_REEL,
] as const;

export const CLIP_COMPLETION_MARKER = "__clip_complete__";
