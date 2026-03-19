import { Command, Option } from "commander";
import chalk from "chalk";
import type { CaptionOutputMode, ClipRenderMode } from "./config";
import { loadConfig } from "./config";
import { CheckpointManager } from "./pipeline/checkpoint";
import { PipelineOrchestrator } from "./pipeline/orchestrator";
import { Downloader } from "./modules/downloader";
import { cleanRunArtifacts } from "./utils/fs";
import { createLogger } from "./utils/logger";

const log = createLogger("cli");

const program = new Command()
  .name("jiang-clips")
  .description("Reel Farmer - Automated short-form clip extraction pipeline")
  .version("1.0.0");

interface PipelineOptions {
  outputMode?: ClipRenderMode;
  captions?: CaptionOutputMode;
}

function addPipelineOptions(command: Command): Command {
  return command
    .addOption(
      new Option("--output-mode <mode>", "Export styled reels or source-aspect clips").choices([
        "reel",
        "source",
      ]),
    )
    .addOption(
      new Option("--captions <mode>", "How captions should be delivered").choices([
        "burned",
        "sidecar",
        "both",
        "none",
      ]),
    );
}

function loadRuntimeConfig(options: PipelineOptions) {
  return loadConfig({
    clipRenderMode: options.outputMode,
    captionOutput: options.captions,
  });
}

addPipelineOptions(
  program
    .command("pipeline")
    .description("Run the full pipeline for a YouTube video")
    .argument("<url>", "YouTube video URL")
    .action(async (url: string, options: PipelineOptions) => {
      const config = loadRuntimeConfig(options);
      const checkpoint = new CheckpointManager(config.paths.checkpointDb);
      const orchestrator = new PipelineOrchestrator(config, checkpoint);

      try {
        const runId = await orchestrator.run(url);
        log.info(`Done! Run ID: ${runId}`);
        log.info(`Output: ./output/`);
      } catch (err) {
        log.error(`Pipeline failed: ${err}`);
        process.exit(1);
      } finally {
        checkpoint.close();
      }
    }),
);

addPipelineOptions(
  program
    .command("batch")
    .description("Process all videos from a YouTube channel")
    .argument("<channel-url>", "YouTube channel URL")
    .option("-l, --limit <n>", "Maximum videos to process", "10")
    .option("--skip-existing", "Skip already processed videos")
    .action(
      async (
        channelUrl: string,
        options: PipelineOptions & { limit: string; skipExisting?: boolean },
      ) => {
        const config = loadRuntimeConfig(options);
        const checkpoint = new CheckpointManager(config.paths.checkpointDb);
        const downloader = new Downloader(config);
        const orchestrator = new PipelineOrchestrator(config, checkpoint);

        try {
          const urls = await downloader.listChannelVideos(channelUrl, parseInt(options.limit));
          log.info(`Found ${urls.length} videos`);

          const existingRuns = checkpoint.getAllRuns();
          const processedUrls = new Set(
            existingRuns.filter((r) => r.status === "completed").map((r) => r.videoUrl),
          );

          for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            if (options.skipExisting && processedUrls.has(url)) {
              log.info(`[${i + 1}/${urls.length}] Skipping (already processed): ${url}`);
              continue;
            }

            log.info(`[${i + 1}/${urls.length}] Processing: ${url}`);
            try {
              await orchestrator.run(url);
            } catch (err) {
              log.error(`Failed: ${err}`);
              log.info("Continuing with next video...");
            }
          }
        } finally {
          checkpoint.close();
        }
      },
    ),
);

addPipelineOptions(
  program
    .command("resume")
    .description("Resume a previously interrupted pipeline run")
    .argument("<run-id>", "Pipeline run ID")
    .action(async (runId: string, options: PipelineOptions) => {
      const config = loadRuntimeConfig(options);
      const checkpoint = new CheckpointManager(config.paths.checkpointDb);
      const orchestrator = new PipelineOrchestrator(config, checkpoint);

      try {
        await orchestrator.resume(runId);
        log.info("Resume completed");
      } catch (err) {
        log.error(`Resume failed: ${err}`);
        process.exit(1);
      } finally {
        checkpoint.close();
      }
    }),
);

program
  .command("status")
  .description("Show status of pipeline runs")
  .argument("[run-id]", "Optional specific run ID")
  .action(async (runId?: string) => {
    const config = loadConfig();
    const checkpoint = new CheckpointManager(config.paths.checkpointDb);

    if (runId) {
      const run = checkpoint.getRunInfo(runId);
      if (!run) {
        log.error(`Run not found: ${runId}`);
        process.exit(1);
      }
      console.log(chalk.bold(`\nRun: ${run.id}`));
      console.log(`  Video: ${run.videoUrl}`);
      console.log(`  Status: ${colorStatus(run.status)}`);
      console.log(`  Stage: ${run.currentStage}`);
      console.log(`  Created: ${run.createdAt}`);
      console.log(`  Updated: ${run.updatedAt}`);
    } else {
      const runs = checkpoint.getAllRuns();
      if (runs.length === 0) {
        console.log("No pipeline runs found.");
        return;
      }
      console.log(chalk.bold(`\n${runs.length} pipeline runs:\n`));
      for (const run of runs) {
        console.log(
          `  ${chalk.dim(run.id.slice(0, 8))} ${colorStatus(run.status)} ${chalk.cyan(run.currentStage)} ${run.videoTitle || run.videoId}`,
        );
      }
    }

    checkpoint.close();
  });

program
  .command("clean")
  .description("Clean intermediate artifacts for a run")
  .argument("<run-id>", "Pipeline run ID")
  .option("--all", "Remove all artifacts including final output")
  .action(async (runId: string, opts: { all?: boolean }) => {
    const config = loadConfig();
    cleanRunArtifacts(config.paths.data, runId, !opts.all);
    log.info(`Cleaned artifacts for run: ${runId}`);
  });

function colorStatus(status: string): string {
  switch (status) {
    case "completed":
      return chalk.green(status);
    case "failed":
      return chalk.red(status);
    case "running":
      return chalk.yellow(status);
    default:
      return chalk.gray(status);
  }
}

program.parse();
