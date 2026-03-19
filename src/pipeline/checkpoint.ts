import { dirname } from "path";
import { Database } from "bun:sqlite";
import { ensureDir } from "@/utils/fs";
import {
  CLIP_COMPLETION_MARKER,
  PipelineStage,
  StageStatus,
  type PipelineRun,
  type StageResult,
} from "./types";

export class CheckpointManager {
  private db: Database;

  constructor(dbPath: string) {
    ensureDir(dirname(dbPath));
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        id TEXT PRIMARY KEY,
        video_url TEXT NOT NULL,
        video_id TEXT NOT NULL,
        video_title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'running',
        current_stage TEXT NOT NULL DEFAULT 'DOWNLOAD',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS stage_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        artifact_paths TEXT NOT NULL DEFAULT '[]',
        data TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (run_id) REFERENCES pipeline_runs(id),
        UNIQUE(run_id, stage)
      );

      CREATE TABLE IF NOT EXISTS clip_progress (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        clip_index INTEGER NOT NULL,
        current_stage TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        artifact_paths TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES pipeline_runs(id)
      );
    `);
  }

  createRun(videoUrl: string, videoId: string, videoTitle: string): PipelineRun {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pipeline_runs (id, video_url, video_id, video_title, status, current_stage, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', 'DOWNLOAD', ?, ?)`,
      )
      .run(id, videoUrl, videoId, videoTitle, now, now);
    return {
      id,
      videoUrl,
      videoId,
      videoTitle,
      createdAt: now,
      updatedAt: now,
      currentStage: PipelineStage.DOWNLOAD,
      status: "running",
    };
  }

  getRunInfo(runId: string): PipelineRun | null {
    const row = this.db.prepare("SELECT * FROM pipeline_runs WHERE id = ?").get(runId) as any;
    if (!row) return null;
    return {
      id: row.id,
      videoUrl: row.video_url,
      videoId: row.video_id,
      videoTitle: row.video_title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      currentStage: row.current_stage as PipelineStage,
      status: row.status,
    };
  }

  getAllRuns(): PipelineRun[] {
    const rows = this.db
      .prepare("SELECT * FROM pipeline_runs ORDER BY created_at DESC")
      .all() as any[];
    return rows.map((row) => ({
      id: row.id,
      videoUrl: row.video_url,
      videoId: row.video_id,
      videoTitle: row.video_title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      currentStage: row.current_stage as PipelineStage,
      status: row.status,
    }));
  }

  startStage(runId: string, stage: PipelineStage): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO stage_results (run_id, stage, status, started_at) VALUES (?, ?, 'in_progress', ?)`,
      )
      .run(runId, stage, now);
    this.db
      .prepare(`UPDATE pipeline_runs SET current_stage = ?, updated_at = ? WHERE id = ?`)
      .run(stage, now, runId);
  }

  completeStage(runId: string, stage: PipelineStage, artifactPaths: string[], data: unknown): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE stage_results SET status = 'completed', artifact_paths = ?, data = ?, completed_at = ? WHERE run_id = ? AND stage = ?`,
      )
      .run(JSON.stringify(artifactPaths), JSON.stringify(data), now, runId, stage);
    this.db.prepare(`UPDATE pipeline_runs SET updated_at = ? WHERE id = ?`).run(now, runId);
  }

  failStage(runId: string, stage: PipelineStage, error: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE stage_results SET status = 'failed', error = ?, completed_at = ? WHERE run_id = ? AND stage = ?`,
      )
      .run(error, now, runId, stage);
    this.db
      .prepare(`UPDATE pipeline_runs SET status = 'failed', updated_at = ? WHERE id = ?`)
      .run(now, runId);
  }

  getStageResult<T = unknown>(runId: string, stage: PipelineStage): StageResult<T> | null {
    const row = this.db
      .prepare("SELECT * FROM stage_results WHERE run_id = ? AND stage = ?")
      .get(runId, stage) as any;
    if (!row) return null;
    return {
      stage: row.stage as PipelineStage,
      status: row.status as StageStatus,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      artifactPaths: JSON.parse(row.artifact_paths),
      data: JSON.parse(row.data) as T,
      error: row.error,
    };
  }

  getLastCompletedStage(runId: string): PipelineStage | null {
    const stages = Object.values(PipelineStage);
    for (let i = stages.length - 1; i >= 0; i--) {
      const result = this.getStageResult(runId, stages[i]);
      if (result?.status === StageStatus.COMPLETED) return stages[i];
    }
    return null;
  }

  updateClipProgress(
    runId: string,
    clipId: string,
    clipIndex: number,
    stage: PipelineStage,
    status: string,
    artifactPaths: Record<string, string>,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO clip_progress (id, run_id, clip_index, current_stage, status, artifact_paths, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(clipId, runId, clipIndex, stage, status, JSON.stringify(artifactPaths), now);
  }

  getClipProgress(
    runId: string,
    clipId: string,
  ): { stage: PipelineStage; status: string; artifactPaths: Record<string, string> } | null {
    const row = this.db
      .prepare("SELECT * FROM clip_progress WHERE id = ? AND run_id = ?")
      .get(clipId, runId) as any;
    if (!row) return null;
    return {
      stage: row.current_stage as PipelineStage,
      status: row.status,
      artifactPaths: JSON.parse(row.artifact_paths),
    };
  }

  getIncompleteClipIds(runId: string): string[] {
    const rows = this.db
      .prepare("SELECT id, status, artifact_paths FROM clip_progress WHERE run_id = ?")
      .all(runId) as any[];
    return rows
      .filter((row) => {
        const artifactPaths = JSON.parse(row.artifact_paths) as Record<string, string>;
        return row.status !== "completed" || artifactPaths[CLIP_COMPLETION_MARKER] !== "true";
      })
      .map((row) => row.id);
  }

  getCompletedClipIds(runId: string): string[] {
    const rows = this.db
      .prepare("SELECT id, status, artifact_paths FROM clip_progress WHERE run_id = ?")
      .all(runId) as any[];
    return rows
      .filter((row) => {
        const artifactPaths = JSON.parse(row.artifact_paths) as Record<string, string>;
        return row.status === "completed" && artifactPaths[CLIP_COMPLETION_MARKER] === "true";
      })
      .map((row) => row.id);
  }

  markRunComplete(runId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE pipeline_runs SET status = 'completed', updated_at = ? WHERE id = ?")
      .run(now, runId);
  }

  markRunFailed(runId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE pipeline_runs SET status = 'failed', updated_at = ? WHERE id = ?")
      .run(now, runId);
  }

  close() {
    this.db.close();
  }
}
