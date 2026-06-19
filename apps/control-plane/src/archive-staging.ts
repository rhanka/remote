/**
 * archive-staging.ts — Phase A0b
 *
 * Durable staging area for workspace archives and exports.
 * Stores files under dataDir/subDir/<sessionId>/archive.tar.gz.
 */

import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// ArchiveStaging
// ---------------------------------------------------------------------------

export class ArchiveStaging {
  private readonly baseDir: string;

  constructor(dataDir?: string, subDir = "staging") {
    const dir = dataDir ?? process.cwd();
    this.baseDir = join(dir, subDir);
    mkdirSync(this.baseDir, { recursive: true });
  }

  private archivePath(sessionId: string): string {
    return join(this.baseDir, sessionId, "archive.tar.gz");
  }

  /**
   * Write the archive buffer to disk.
   * Returns the path where it was stored.
   */
  stageArchive(sessionId: string, data: Buffer): string {
    const path = this.archivePath(sessionId);
    mkdirSync(join(this.baseDir, sessionId), { recursive: true });
    writeFileSync(path, data);
    return path;
  }

  /**
   * Read the staged archive for a session.
   * Returns null if no archive exists.
   */
  readStagedArchive(sessionId: string): Buffer | null {
    try {
      return readFileSync(this.archivePath(sessionId));
    } catch {
      return null;
    }
  }

  /**
   * Remove the staged archive for a session.
   * No-op if it doesn't exist.
   */
  clearStagedArchive(sessionId: string): void {
    rmSync(join(this.baseDir, sessionId), { recursive: true, force: true });
  }
}
