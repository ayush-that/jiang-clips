import { createLogger } from "../utils/logger";
import {
  runFfmpeg,
  detectSilence,
  secondsToFfmpegTimestamp,
  getVideoDuration,
} from "../utils/ffmpeg";
import { listFiles, randomItem, fileExists, ensureDir } from "../utils/fs";
import type { Config } from "../config";
import type { ClipCandidate } from "../pipeline/types";
import { dirname, extname, join } from "path";

const log = createLogger("video-processor");

export interface SpeechRange {
  start: number;
  end: number;
}

export class VideoProcessor {
  async extractClip(videoPath: string, clip: ClipCandidate, outputDir: string): Promise<string> {
    const outputExtension = this.getClipExtension(videoPath);
    const outputPath = join(outputDir, `${clip.id}_raw${outputExtension}`);

    if (await fileExists(outputPath)) {
      log.info(`Clip already extracted: ${clip.title}`);
      return outputPath;
    }

    log.info(`Extracting clip: "${clip.title}" (${clip.startTime}s - ${clip.endTime}s)`);
    await runFfmpeg([
      "-i",
      videoPath,
      "-ss",
      secondsToFfmpegTimestamp(clip.startTime),
      "-to",
      secondsToFfmpegTimestamp(clip.endTime),
      ...this.getEncodingArgs(outputExtension),
      "-y",
      outputPath,
    ]);

    return outputPath;
  }

  async exportClip(clipPath: string, outputPath: string): Promise<string> {
    ensureDir(dirname(outputPath));

    if (await fileExists(outputPath)) {
      log.info("Exported clip already exists");
      return outputPath;
    }

    await Bun.write(outputPath, Bun.file(clipPath));
    log.info(`Clip exported: ${outputPath}`);
    return outputPath;
  }

  async removeSilence(
    clipPath: string,
    outputPath: string,
    config: Config,
  ): Promise<{ path: string; speechRanges: SpeechRange[] | null }> {
    if (await fileExists(outputPath)) {
      log.info("Silence-removed clip already exists");
      return { path: outputPath, speechRanges: null };
    }

    log.info("Detecting silence...");
    const silenceRanges = await detectSilence(
      clipPath,
      config.silenceThresholdDb,
      config.silenceMinDuration,
    );

    if (silenceRanges.length === 0) {
      log.info("No significant silence detected, copying as-is");
      await Bun.write(outputPath, Bun.file(clipPath));
      return { path: outputPath, speechRanges: null };
    }

    const clipDuration = await getVideoDuration(clipPath);
    const speechRanges = this.invertRanges(silenceRanges, clipDuration, 0.05);

    if (speechRanges.length === 0) {
      log.warn("No speech ranges found, keeping original");
      await Bun.write(outputPath, Bun.file(clipPath));
      return { path: outputPath, speechRanges: null };
    }

    const totalSpeech = speechRanges.reduce((sum, r) => sum + (r.end - r.start), 0);
    if (totalSpeech < 10) {
      log.warn(`Too short after silence removal (${totalSpeech.toFixed(1)}s), keeping original`);
      await Bun.write(outputPath, Bun.file(clipPath));
      return { path: outputPath, speechRanges: null };
    }

    log.info(
      `Removing ${silenceRanges.length} silence gaps (keeping ${totalSpeech.toFixed(1)}s of ${clipDuration.toFixed(1)}s)`,
    );

    // Use trim/atrim + concat to preserve A/V sync (select/aselect causes drift)
    const filterParts: string[] = [];
    const concatInputs: string[] = [];
    for (let i = 0; i < speechRanges.length; i++) {
      const r = speechRanges[i];
      filterParts.push(
        `[0:v]trim=${r.start.toFixed(3)}:${r.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}];`,
      );
      filterParts.push(
        `[0:a]atrim=${r.start.toFixed(3)}:${r.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}];`,
      );
      concatInputs.push(`[v${i}][a${i}]`);
    }
    const filterComplex =
      filterParts.join("") +
      `${concatInputs.join("")}concat=n=${speechRanges.length}:v=1:a=1[outv][outa]`;

    await runFfmpeg([
      "-i",
      clipPath,
      "-filter_complex",
      filterComplex,
      "-map",
      "[outv]",
      "-map",
      "[outa]",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "18",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-y",
      outputPath,
    ]);

    return { path: outputPath, speechRanges };
  }

  async composeReel(
    clipPath: string,
    config: Config,
    outputPath: string,
    captionOverlayPath?: string | null,
  ): Promise<string> {
    ensureDir(dirname(outputPath));

    if (await fileExists(outputPath)) {
      log.info("Reel already composed");
      return outputPath;
    }

    const surferFiles = listFiles(config.paths.subwaySurfers, ".mp4");
    if (surferFiles.length === 0) {
      log.warn("No subway surfers footage found, creating single-video reel");
      return this.composeSingleReel(clipPath, config, outputPath, captionOverlayPath);
    }

    const surferPath = randomItem(surferFiles);
    const surferDuration = await getVideoDuration(surferPath);
    const clipDuration = await getVideoDuration(clipPath);

    const speed = config.clipSpeed;
    const effectiveClipDuration = clipDuration / speed;
    const maxOffset = Math.max(0, surferDuration - effectiveClipDuration);
    const surferOffset = Math.random() * maxOffset;

    log.info(`Composing split-screen reel (${speed}x speed)...`);

    const halfHeight = Math.floor(config.outputHeight / 2);
    const w = config.outputWidth;
    const h = config.outputHeight;
    const hasCaptions = captionOverlayPath && (await fileExists(captionOverlayPath));

    let filterComplex =
      `[0:v]fps=30,scale=${w}:${halfHeight}:force_original_aspect_ratio=increase,crop=${w}:${halfHeight}[top];` +
      `[1:v]fps=30,setpts=PTS/${speed},scale=${w}:${halfHeight}:force_original_aspect_ratio=increase,crop=${w}:${halfHeight}[bottom];` +
      `[1:a]atempo=${speed}[afast];` +
      `[top][bottom]vstack=inputs=2[bg]`;

    if (hasCaptions) {
      filterComplex +=
        `;[2:v]fps=30,scale=${w}:${h},colorkey=0x00FF00:0.3:0.1[captions];` +
        `[bg][captions]overlay=0:0:format=auto[out]`;
    } else {
      filterComplex += `;[bg]copy[out]`;
    }

    const inputs = [
      "-ss",
      secondsToFfmpegTimestamp(surferOffset),
      "-i",
      surferPath,
      "-i",
      clipPath,
    ];

    if (hasCaptions) {
      inputs.push("-i", captionOverlayPath!);
    }

    await runFfmpeg([
      ...inputs,
      "-filter_complex",
      filterComplex,
      "-map",
      "[out]",
      "-map",
      "[afast]",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-r",
      "30",
      "-shortest",
      "-y",
      outputPath,
    ]);

    log.info(`Reel composed: ${outputPath}`);
    return outputPath;
  }

  private async composeSingleReel(
    clipPath: string,
    config: Config,
    outputPath: string,
    captionOverlayPath?: string | null,
  ): Promise<string> {
    const w = config.outputWidth;
    const h = config.outputHeight;
    const speed = config.clipSpeed;
    const hasCaptions = captionOverlayPath && (await fileExists(captionOverlayPath));

    let filterComplex =
      `[0:v]fps=30,setpts=PTS/${speed},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}[base];` +
      `[0:a]atempo=${speed}[afast]`;

    if (hasCaptions) {
      filterComplex +=
        `;[1:v]fps=30,scale=${w}:${h},colorkey=0x00FF00:0.3:0.1[captions];` +
        `[base][captions]overlay=0:0:format=auto[out]`;
    } else {
      filterComplex += `;[base]copy[out]`;
    }

    const inputs = ["-i", clipPath];
    if (hasCaptions) {
      inputs.push("-i", captionOverlayPath!);
    }

    await runFfmpeg([
      ...inputs,
      "-filter_complex",
      filterComplex,
      "-map",
      "[out]",
      "-map",
      "[afast]",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-r",
      "30",
      "-y",
      outputPath,
    ]);

    return outputPath;
  }

  private invertRanges(
    silenceRanges: Array<{ start: number; end: number }>,
    totalDuration: number,
    buffer: number,
  ): Array<{ start: number; end: number }> {
    const sorted = [...silenceRanges].sort((a, b) => a.start - b.start);
    const speech: Array<{ start: number; end: number }> = [];
    let cursor = 0;

    for (const silence of sorted) {
      const speechStart = cursor;
      const speechEnd = Math.max(cursor, silence.start - buffer);
      if (speechEnd - speechStart > 0.05) {
        speech.push({ start: Math.max(0, speechStart), end: speechEnd });
      }
      cursor = silence.end + buffer;
    }

    if (cursor < totalDuration) {
      speech.push({ start: cursor, end: totalDuration });
    }

    return speech;
  }

  private getClipExtension(videoPath: string): string {
    const inputExtension = extname(videoPath).toLowerCase();
    return inputExtension === ".webm" ? ".webm" : ".mp4";
  }

  private getEncodingArgs(outputExtension: string): string[] {
    if (outputExtension === ".webm") {
      return [
        "-c:v",
        "libvpx-vp9",
        "-crf",
        "33",
        "-b:v",
        "0",
        "-deadline",
        "good",
        "-cpu-used",
        "4",
        "-c:a",
        "libopus",
        "-b:a",
        "128k",
      ];
    }

    return ["-c:v", "libx264", "-preset", "fast", "-crf", "18", "-c:a", "aac", "-b:a", "192k"];
  }
}
