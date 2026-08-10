import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StorageError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { MonitorState, StateStorage } from './types.js';

/**
 * JSON-file storage — the default for local development and for Railway when a
 * Volume is mounted. Writes go through a temp file + rename so a crash mid-write
 * cannot leave a truncated state behind.
 */
export class JsonFileStorage implements StateStorage {
  readonly name = 'json';

  constructor(private readonly filePath: string) {}

  async getLastState(): Promise<MonitorState | null> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<MonitorState>;
      if (typeof parsed.fingerprint !== 'string' || typeof parsed.notifiedAt !== 'string') {
        logger.warn('El estado guardado no tiene el formato esperado; se ignora', { archivo: this.filePath });
        return null;
      }
      return {
        fingerprint: parsed.fingerprint,
        notifiedAt: parsed.notifiedAt,
        lastRunAt: parsed.lastRunAt ?? parsed.notifiedAt,
        lastAvailable: parsed.lastAvailable ?? false,
        runsSinceLastReport: parsed.runsSinceLastReport ?? 0,
        lastRunFailed: parsed.lastRunFailed ?? false,
        ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      logger.warn('No se pudo leer el estado previo; se continúa sin él', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async saveState(state: MonitorState): Promise<void> {
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
      await rename(tmp, this.filePath);
      logger.debug('Estado guardado', { archivo: this.filePath });
    } catch (error) {
      throw new StorageError(`No se pudo guardar el estado en ${this.filePath}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}
