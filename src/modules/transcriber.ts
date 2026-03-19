import { createLogger } from "../utils/logger";
import { secondsToSrtTimestamp } from "../utils/ffmpeg";
import type { Config } from "../config";
import type { TranscriptSegment, Transcript, VideoMetadata } from "../pipeline/types";
import { join } from "path";

const log = createLogger("transcriber");

function pythonExecutable(): string {
  return process.platform === "win32" ? "python" : "python3";
}

export class Transcriber {
  async transcribe(
    metadata: VideoMetadata,
    outputDir: string,
    config: Config,
  ): Promise<Transcript> {
    if (config.preferYouTubeTranscripts) {
      try {
        log.info("Attempting YouTube transcript fetch...");
        return await this.fromYouTube(metadata, outputDir);
      } catch (err) {
        log.warn(`YouTube transcript unavailable: ${err}. Falling back to Whisper.`);
      }
    }

    return await this.fromWhisper(metadata, outputDir, config);
  }

  private async fromYouTube(metadata: VideoMetadata, outputDir: string): Promise<Transcript> {
    const script = `
import json
from youtube_transcript_api import YouTubeTranscriptApi
ytt_api = YouTubeTranscriptApi()
fetched = ytt_api.fetch("${metadata.videoId}")
snippets = [{"text": s.text, "start": s.start, "duration": s.duration} for s in fetched.snippets]
print(json.dumps(snippets))
`;
    const proc = Bun.spawn([pythonExecutable(), "-c", script], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) throw new Error(`YouTube transcript fetch failed: ${stderr}`);

    const raw = JSON.parse(stdout) as Array<{ text: string; start: number; duration: number }>;
    const segments: TranscriptSegment[] = raw.map((s) => ({
      text: s.text,
      start: s.start,
      duration: s.duration,
      end: s.start + s.duration,
    }));

    const fullText = segments.map((s) => s.text).join(" ");
    const srtPath = join(outputDir, "transcript.srt");
    await this.writeSrt(segments, srtPath);

    log.info(`YouTube transcript: ${segments.length} segments`);
    return { source: "youtube", language: "en", segments, fullText, srtPath };
  }

  private async fromWhisper(
    metadata: VideoMetadata,
    outputDir: string,
    config: Config,
  ): Promise<Transcript> {
    log.info(`Running Whisper (model: ${config.whisperModel})...`);
    const script = `
import whisper, json, sys
model = whisper.load_model("${config.whisperModel}")
result = model.transcribe("${metadata.filePath}", language="en")
segments = [{"text": s["text"].strip(), "start": s["start"], "end": s["end"], "duration": s["end"] - s["start"]} for s in result["segments"]]
print(json.dumps(segments))
`;
    const proc = Bun.spawn([pythonExecutable(), "-c", script], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) throw new Error(`Whisper transcription failed: ${stderr}`);

    const raw = JSON.parse(stdout) as Array<{
      text: string;
      start: number;
      end: number;
      duration: number;
    }>;
    const segments: TranscriptSegment[] = raw.map((s) => ({
      text: s.text,
      start: s.start,
      duration: s.duration,
      end: s.end,
    }));

    const fullText = segments.map((s) => s.text).join(" ");
    const srtPath = join(outputDir, "transcript.srt");
    await this.writeSrt(segments, srtPath);

    log.info(`Whisper transcript: ${segments.length} segments`);
    return { source: "whisper", language: "en", segments, fullText, srtPath };
  }

  async writeSrt(segments: TranscriptSegment[], outputPath: string): Promise<void> {
    const lines: string[] = [];
    segments.forEach((seg, i) => {
      lines.push(String(i + 1));
      lines.push(`${secondsToSrtTimestamp(seg.start)} --> ${secondsToSrtTimestamp(seg.end)}`);
      lines.push(seg.text);
      lines.push("");
    });
    await Bun.write(outputPath, lines.join("\n"));
  }
}
