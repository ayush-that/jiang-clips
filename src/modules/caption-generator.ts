import { createLogger } from "../utils/logger";
import { getVideoDuration, runFfmpeg, secondsToSrtTimestamp } from "../utils/ffmpeg";
import { ensureDir } from "../utils/fs";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { basename, dirname, extname, join, resolve } from "path";
import type { Config } from "../config";
import type { CaptionWord, CaptionGroup, CaptionOverlayProps } from "../remotion/types";

const log = createLogger("captions");
const FPS = 30;
const WORDS_PER_GROUP = 6;
const MODELS_DIR = resolve(__dirname, "../../models");

let bundlePromise: Promise<string> | null = null;

interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

interface TimedWord {
  text: string;
  start: number;
  end: number;
}

interface CaptionCue {
  text: string;
  start: number;
  end: number;
}

export class CaptionGenerator {
  async warmup(): Promise<void> {
    await this.ensureBundle();
  }

  private async ensureBundle(): Promise<string> {
    if (!bundlePromise) {
      log.info("Bundling Remotion project...");
      bundlePromise = bundle({
        entryPoint: resolve(__dirname, "../remotion/index.tsx"),
        webpackOverride: (config) => config,
      });
      const location = await bundlePromise;
      log.info(`Remotion bundle ready: ${location}`);
    }
    return bundlePromise;
  }

  async generate(desilencedClipPath: string, outputPath: string, config: Config): Promise<string> {
    const serveUrl = await this.ensureBundle();
    const clipDuration = await getVideoDuration(desilencedClipPath);
    const speed = config.clipSpeed;

    const workDir = dirname(outputPath);
    const timedWords = await this.extractTimedWords(
      desilencedClipPath,
      config,
      workDir,
      outputPath,
      config.clipSpeed,
    );
    const framed: CaptionWord[] = timedWords.map((w) => ({
      text: w.text,
      startFrame: Math.round(w.start * FPS),
      endFrame: Math.round(w.end * FPS),
    }));

    const groups = this.groupWords(framed);
    const postSpeedDuration = clipDuration / speed;
    const durationInFrames = Math.ceil(postSpeedDuration * FPS);
    const width = config.outputWidth;
    const height = config.outputHeight;

    const inputProps: CaptionOverlayProps = {
      groups,
      width,
      height,
      fps: FPS,
      durationInFrames,
    };

    ensureDir(dirname(outputPath));

    log.info(`Rendering caption overlay (${groups.length} groups, ${durationInFrames} frames)...`);

    const composition = await selectComposition({
      serveUrl,
      id: "CaptionOverlay",
      inputProps,
    });

    let lastLoggedPct = -1;
    await renderMedia({
      composition,
      serveUrl,
      codec: "vp9",
      imageFormat: "png",
      pixelFormat: "yuva420p",
      outputLocation: outputPath,
      inputProps,
      onProgress: ({ progress }) => {
        const pct = Math.floor(progress * 100);
        if (pct >= lastLoggedPct + 10) {
          lastLoggedPct = pct;
          log.info(`Caption render: ${pct}%`);
        }
      },
    });

    log.info(`Caption overlay rendered: ${outputPath}`);
    return outputPath;
  }

  async generateSrt(videoPath: string, outputPath: string, config: Config): Promise<string> {
    ensureDir(dirname(outputPath));

    const workDir = dirname(outputPath);
    const timedWords = await this.extractTimedWords(videoPath, config, workDir, outputPath);
    const cues = this.groupTimedWords(timedWords);

    const lines: string[] = [];
    cues.forEach((cue, index) => {
      lines.push(String(index + 1));
      lines.push(`${secondsToSrtTimestamp(cue.start)} --> ${secondsToSrtTimestamp(cue.end)}`);
      lines.push(cue.text);
      lines.push("");
    });

    await Bun.write(outputPath, lines.join("\n"));
    log.info(`Caption sidecar written: ${outputPath}`);
    return outputPath;
  }

  private async extractTimedWords(
    videoPath: string,
    config: Config,
    workDir: string,
    outputPath: string,
    timingDivisor = 1,
  ): Promise<TimedWord[]> {
    const whisperWords = await this.whisperWordTimestamps(
      videoPath,
      config,
      workDir,
      config.whisperCliPath,
      outputPath,
    );
    log.info(`Whisper extracted ${whisperWords.length} words`);

    return whisperWords.map((word) => ({
      text: word.word,
      start: word.start / timingDivisor,
      end: word.end / timingDivisor,
    }));
  }

  private async whisperWordTimestamps(
    videoPath: string,
    config: Config,
    workDir: string,
    whisperCli: string,
    outputPath: string,
  ): Promise<WhisperWord[]> {
    const modelPath = join(MODELS_DIR, `ggml-${config.whisperModel}.bin`);
    log.info(`Running whisper-cli word-level transcription (model: ${config.whisperModel})...`);

    const tempBase = basename(outputPath, extname(outputPath));
    const wavPath = join(workDir, `${tempBase}_audio.wav`);
    await runFfmpeg(["-i", videoPath, "-ar", "16000", "-ac", "1", "-f", "wav", "-y", wavPath]);

    const jsonBase = join(workDir, `${tempBase}_words`);
    const proc = Bun.spawn(
      [
        whisperCli,
        "-m",
        modelPath,
        "-f",
        wavPath,
        "-l",
        "en",
        "-oj",
        "--output-json-full",
        "-of",
        jsonBase,
        "-np",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw new Error(`whisper-cli failed: ${stderr}`);
    }

    const jsonPath = `${jsonBase}.json`;
    const json = await Bun.file(jsonPath).json();
    const words: WhisperWord[] = [];

    for (const segment of json.transcription) {
      for (const token of segment.tokens) {
        const text = token.text.trim();
        if (!text || text.startsWith("[")) continue;
        if ((/^[,.\?!;:]$/.test(text) || text.startsWith("'")) && words.length > 0) {
          words[words.length - 1].word += text;
          words[words.length - 1].end = token.offsets.to / 1000;
        } else {
          words.push({
            word: text,
            start: token.offsets.from / 1000,
            end: token.offsets.to / 1000,
          });
        }
      }
    }

    return words;
  }

  private groupTimedWords(words: TimedWord[]): CaptionCue[] {
    const cues: CaptionCue[] = [];

    for (let i = 0; i < words.length; i += WORDS_PER_GROUP) {
      const chunk = words.slice(i, i + WORDS_PER_GROUP);
      cues.push({
        text: chunk.map((word) => word.text).join(" "),
        start: chunk[0].start,
        end: chunk[chunk.length - 1].end,
      });
    }

    return cues;
  }

  private groupWords(words: CaptionWord[]): CaptionGroup[] {
    const groups: CaptionGroup[] = [];

    for (let i = 0; i < words.length; i += WORDS_PER_GROUP) {
      const chunk = words.slice(i, i + WORDS_PER_GROUP);
      groups.push({
        words: chunk,
        startFrame: chunk[0].startFrame,
        endFrame: chunk[chunk.length - 1].endFrame,
      });
    }

    return groups;
  }
}
