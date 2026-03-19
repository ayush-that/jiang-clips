import { createLogger } from "../utils/logger";
import { runDir, ensureDir } from "../utils/fs";
import { CheckpointManager } from "./checkpoint";
import { CLIP_COMPLETION_MARKER, PipelineStage, StageStatus } from "./types";
import type { Config } from "../config";
import type { VideoMetadata, Transcript, ClipCandidate, ClipArtifacts } from "./types";
import { Downloader } from "../modules/downloader";
import { Transcriber } from "../modules/transcriber";
import { ClipIdentifier } from "../modules/clip-identifier";
import { VideoProcessor } from "../modules/video-processor";
import { CaptionGenerator } from "../modules/caption-generator";
import { basename, dirname, extname, join } from "path";

const log = createLogger("orchestrator");

class Semaphore {
  private count: number;
  private queue: Array<() => void> = [];

  constructor(max: number) {
    this.count = max;
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return;
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.count++;
    }
  }
}

export class PipelineOrchestrator {
  private checkpoint: CheckpointManager;
  private config: Config;
  private downloader: Downloader;

  private transcriber = new Transcriber();
  private clipIdentifier: ClipIdentifier;
  private videoProcessor = new VideoProcessor();
  private captionGenerator = new CaptionGenerator();

  constructor(config: Config, checkpoint: CheckpointManager) {
    this.config = config;
    this.checkpoint = checkpoint;
    this.downloader = new Downloader(config);
    this.clipIdentifier = new ClipIdentifier(config);
  }

  async run(videoUrl: string, _fromStage?: PipelineStage): Promise<string> {
    const videoId = this.extractVideoId(videoUrl);
    const run = this.checkpoint.createRun(videoUrl, videoId, "");
    const dir = runDir(this.config.paths.data, run.id);

    log.info(`Pipeline started: ${run.id}`);
    log.info(`Video: ${videoUrl}`);

    try {
      const metadata = await this.stageDownload(run.id, videoUrl, dir);
      const transcript = await this.stageTranscribe(run.id, metadata, dir);
      let clips = await this.stageIdentifyClips(run.id, transcript, metadata, dir);
      if (this.config.maxClips > 0) {
        clips = clips.slice(0, this.config.maxClips);
        log.info(`Limiting to ${clips.length} clips (maxClips=${this.config.maxClips})`);
      }
      await this.processClips(run.id, clips, metadata, dir);
      this.checkpoint.markRunComplete(run.id);
      log.info(`Pipeline completed: ${run.id}`);
    } catch (err) {
      log.error(`Pipeline failed: ${err}`);
      this.checkpoint.markRunFailed(run.id);
      throw err;
    }

    return run.id;
  }

  async resume(runId: string): Promise<void> {
    const run = this.checkpoint.getRunInfo(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    log.info(`Resuming pipeline: ${runId}`);
    const dir = runDir(this.config.paths.data, runId);

    try {
      let metadata: VideoMetadata;
      const dlResult = this.checkpoint.getStageResult<VideoMetadata>(runId, PipelineStage.DOWNLOAD);
      if (dlResult?.status === StageStatus.COMPLETED) {
        metadata = dlResult.data;
        log.info("Skipping DOWNLOAD (completed)");
      } else {
        metadata = await this.stageDownload(runId, run.videoUrl, dir);
      }

      let transcript: Transcript;
      const txResult = this.checkpoint.getStageResult<Transcript>(runId, PipelineStage.TRANSCRIBE);
      if (txResult?.status === StageStatus.COMPLETED) {
        transcript = txResult.data;
        log.info("Skipping TRANSCRIBE (completed)");
      } else {
        transcript = await this.stageTranscribe(runId, metadata, dir);
      }

      let clips: ClipCandidate[];
      const idResult = this.checkpoint.getStageResult<ClipCandidate[]>(
        runId,
        PipelineStage.IDENTIFY_CLIPS,
      );
      if (idResult?.status === StageStatus.COMPLETED) {
        clips = idResult.data;
        log.info("Skipping IDENTIFY_CLIPS (completed)");
      } else {
        clips = await this.stageIdentifyClips(runId, transcript, metadata, dir);
      }

      const completedIds = new Set(this.checkpoint.getCompletedClipIds(runId));
      const remainingClips = clips.filter((c) => !completedIds.has(c.id));

      if (remainingClips.length === 0) {
        log.info("All clips already processed");
      } else {
        log.info(`Resuming ${remainingClips.length}/${clips.length} clips`);
        await this.processClips(runId, remainingClips, metadata, dir);
      }

      this.checkpoint.markRunComplete(runId);
      log.info(`Pipeline resumed and completed: ${runId}`);
    } catch (err) {
      log.error(`Resume failed: ${err}`);
      this.checkpoint.markRunFailed(runId);
      throw err;
    }
  }

  private async stageDownload(
    runId: string,
    videoUrl: string,
    dir: string,
  ): Promise<VideoMetadata> {
    this.checkpoint.startStage(runId, PipelineStage.DOWNLOAD);
    const downloadDir = join(dir, "downloads");
    const metadata = await this.downloader.download(videoUrl, downloadDir);
    this.checkpoint.completeStage(runId, PipelineStage.DOWNLOAD, [metadata.filePath], metadata);
    return metadata;
  }

  private async stageTranscribe(
    runId: string,
    metadata: VideoMetadata,
    dir: string,
  ): Promise<Transcript> {
    this.checkpoint.startStage(runId, PipelineStage.TRANSCRIBE);
    const transcriptDir = join(dir, "transcripts");
    const transcript = await this.transcriber.transcribe(metadata, transcriptDir, this.config);
    this.checkpoint.completeStage(
      runId,
      PipelineStage.TRANSCRIBE,
      [transcript.srtPath ?? ""],
      transcript,
    );
    return transcript;
  }

  private async stageIdentifyClips(
    runId: string,
    transcript: Transcript,
    metadata: VideoMetadata,
    dir: string,
  ): Promise<ClipCandidate[]> {
    this.checkpoint.startStage(runId, PipelineStage.IDENTIFY_CLIPS);
    const clips = await this.clipIdentifier.identify(transcript, metadata);
    const clipsPath = join(dir, "clips.json");
    await Bun.write(clipsPath, JSON.stringify(clips, null, 2));
    this.checkpoint.completeStage(runId, PipelineStage.IDENTIFY_CLIPS, [clipsPath], clips);
    log.info(`Identified ${clips.length} clips`);
    return clips;
  }

  private async processClips(
    runId: string,
    clips: ClipCandidate[],
    metadata: VideoMetadata,
    dir: string,
  ): Promise<void> {
    const semaphore = new Semaphore(this.config.maxParallelClips);
    const outputDir = join(this.config.paths.output, metadata.videoId);
    ensureDir(outputDir);

    if (this.shouldRenderCaptionOverlay()) {
      await this.captionGenerator.warmup();
    }

    log.info(`Processing ${clips.length} clips (parallel: ${this.config.maxParallelClips})`);

    const results = await Promise.allSettled(
      clips.map(async (clip, index) => {
        await semaphore.acquire();
        try {
          log.info(`[${index + 1}/${clips.length}] Processing: "${clip.title}"`);
          await this.processOneClip(runId, clip, index, metadata, dir, outputDir);
          log.info(`[${index + 1}/${clips.length}] Completed: "${clip.title}"`);
        } finally {
          semaphore.release();
        }
      }),
    );

    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      log.warn(`${failed.length}/${clips.length} clips failed`);
      for (const f of failed) {
        if (f.status === "rejected") log.error(`  ${f.reason}`);
      }
    }

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    log.info(`${succeeded}/${clips.length} clips processed successfully`);
  }

  private async processOneClip(
    runId: string,
    clip: ClipCandidate,
    clipIndex: number,
    metadata: VideoMetadata,
    dir: string,
    outputDir: string,
  ): Promise<ClipArtifacts> {
    const progress = this.checkpoint.getClipProgress(runId, clip.id);

    const artifacts: Partial<ClipArtifacts> = {
      clipId: clip.id,
      extractedVideoPath: progress?.artifactPaths.extractedVideoPath,
      silenceRemovedPath: progress?.artifactPaths.silenceRemovedPath,
      captionOverlayPath: progress?.artifactPaths.captionOverlayPath,
      captionSrtPath: progress?.artifactPaths.captionSrtPath ?? progress?.artifactPaths.srtPath,
      exportedVideoPath:
        progress?.artifactPaths.exportedVideoPath ??
        (this.shouldComposeReel() ? progress?.artifactPaths.finalReelPath : undefined),
      finalReelPath: progress?.artifactPaths.finalReelPath,
    };
    let finalStage = PipelineStage.EXTRACT_CLIPS;

    if (!artifacts.extractedVideoPath) {
      this.checkpoint.updateClipProgress(
        runId,
        clip.id,
        clipIndex,
        PipelineStage.EXTRACT_CLIPS,
        "in_progress",
        this.toArtifactPaths(artifacts),
      );
      artifacts.extractedVideoPath = await this.videoProcessor.extractClip(
        metadata.filePath,
        clip,
        join(dir, "clips"),
      );
      this.checkpoint.updateClipProgress(
        runId,
        clip.id,
        clipIndex,
        PipelineStage.EXTRACT_CLIPS,
        "completed",
        this.toArtifactPaths(artifacts),
      );
    }

    if (this.shouldComposeReel()) {
      if (!artifacts.silenceRemovedPath) {
        this.checkpoint.updateClipProgress(
          runId,
          clip.id,
          clipIndex,
          PipelineStage.REMOVE_SILENCE,
          "in_progress",
          this.toArtifactPaths(artifacts),
        );
        const desilencedPath = join(dir, "desilenced", `${clip.id}_clean.mp4`);
        const result = await this.videoProcessor.removeSilence(
          artifacts.extractedVideoPath,
          desilencedPath,
          this.config,
        );
        artifacts.silenceRemovedPath = result.path;
        this.checkpoint.updateClipProgress(
          runId,
          clip.id,
          clipIndex,
          PipelineStage.REMOVE_SILENCE,
          "completed",
          this.toArtifactPaths(artifacts),
        );
      }
      finalStage = PipelineStage.REMOVE_SILENCE;

      if (this.shouldRenderCaptionOverlay() && !artifacts.captionOverlayPath) {
        this.checkpoint.updateClipProgress(
          runId,
          clip.id,
          clipIndex,
          PipelineStage.GENERATE_CAPTIONS,
          "in_progress",
          this.toArtifactPaths(artifacts),
        );
        const overlayPath = join(dir, "captions", `${clip.id}_captions.webm`);
        artifacts.captionOverlayPath = await this.captionGenerator.generate(
          artifacts.silenceRemovedPath,
          overlayPath,
          this.config,
        );
        this.checkpoint.updateClipProgress(
          runId,
          clip.id,
          clipIndex,
          PipelineStage.GENERATE_CAPTIONS,
          "completed",
          this.toArtifactPaths(artifacts),
        );
      }

      if (!artifacts.exportedVideoPath) {
        this.checkpoint.updateClipProgress(
          runId,
          clip.id,
          clipIndex,
          PipelineStage.COMPOSE_REEL,
          "in_progress",
          this.toArtifactPaths(artifacts),
        );
        artifacts.finalReelPath = join(outputDir, `${clip.id}_reel.mp4`);
        artifacts.exportedVideoPath = await this.videoProcessor.composeReel(
          artifacts.silenceRemovedPath,
          this.config,
          artifacts.finalReelPath,
          this.shouldRenderCaptionOverlay() ? artifacts.captionOverlayPath : undefined,
        );
        this.checkpoint.updateClipProgress(
          runId,
          clip.id,
          clipIndex,
          PipelineStage.COMPOSE_REEL,
          "completed",
          this.toArtifactPaths(artifacts),
        );
      }
      finalStage = PipelineStage.COMPOSE_REEL;
    } else if (!artifacts.exportedVideoPath) {
      artifacts.exportedVideoPath = await this.videoProcessor.exportClip(
        artifacts.extractedVideoPath,
        this.getSourceClipOutputPath(outputDir, clip.id, artifacts.extractedVideoPath),
      );
      this.checkpoint.updateClipProgress(
        runId,
        clip.id,
        clipIndex,
        PipelineStage.EXTRACT_CLIPS,
        "completed",
        this.toArtifactPaths(artifacts),
      );
    }

    if (this.shouldWriteCaptionSidecar()) {
      if (!artifacts.exportedVideoPath) {
        throw new Error(`Clip export missing for caption generation: ${clip.id}`);
      }

      if (!artifacts.captionSrtPath) {
        this.checkpoint.updateClipProgress(
          runId,
          clip.id,
          clipIndex,
          PipelineStage.GENERATE_CAPTIONS,
          "in_progress",
          this.toArtifactPaths(artifacts),
        );
        artifacts.captionSrtPath = await this.captionGenerator.generateSrt(
          artifacts.exportedVideoPath,
          this.getCaptionSidecarPath(artifacts.exportedVideoPath),
          this.config,
        );
        this.checkpoint.updateClipProgress(
          runId,
          clip.id,
          clipIndex,
          PipelineStage.GENERATE_CAPTIONS,
          "completed",
          this.toArtifactPaths(artifacts),
        );
      }
      finalStage = PipelineStage.GENERATE_CAPTIONS;
    }

    this.checkpoint.updateClipProgress(
      runId,
      clip.id,
      clipIndex,
      finalStage,
      "completed",
      this.toArtifactPaths(artifacts, true),
    );

    return artifacts as ClipArtifacts;
  }

  private shouldComposeReel(): boolean {
    return this.config.clipRenderMode === "reel";
  }

  private shouldRenderCaptionOverlay(): boolean {
    return this.config.captionOutput === "burned" || this.config.captionOutput === "both";
  }

  private shouldWriteCaptionSidecar(): boolean {
    return this.config.captionOutput === "sidecar" || this.config.captionOutput === "both";
  }

  private getSourceClipOutputPath(outputDir: string, clipId: string, sourcePath: string): string {
    const extension = extname(sourcePath) || ".mp4";
    return join(outputDir, `${clipId}_clip${extension}`);
  }

  private getCaptionSidecarPath(videoPath: string): string {
    const extension = extname(videoPath);
    const stem = extension ? basename(videoPath, extension) : basename(videoPath);
    return join(dirname(videoPath), `${stem}.srt`);
  }

  private toArtifactPaths(
    artifacts: Partial<ClipArtifacts>,
    isComplete = false,
  ): Record<string, string> {
    const artifactPaths: Record<string, string> = {};

    for (const [key, value] of Object.entries(artifacts)) {
      if (key === "clipId" || typeof value !== "string" || value.length === 0) {
        continue;
      }
      artifactPaths[key] = value;
    }

    if (isComplete) {
      artifactPaths[CLIP_COMPLETION_MARKER] = "true";
    }

    return artifactPaths;
  }

  private extractVideoId(url: string): string {
    const match = url.match(/(?:v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return match?.[1] ?? url.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 32);
  }
}
