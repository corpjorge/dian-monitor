import type { AppConfig } from '../config/env.js';
import { JsonFileStorage } from './json-file.js';
import { MemoryStorage } from './memory.js';
import type { StateStorage } from './types.js';

export type { MonitorState, StateStorage } from './types.js';
export { JsonFileStorage } from './json-file.js';
export { MemoryStorage } from './memory.js';

/** Picks the storage implementation from `STATE_BACKEND`. */
export function createStorage(config: AppConfig): StateStorage {
  switch (config.storage.backend) {
    case 'memory':
      return new MemoryStorage();
    case 'json':
    default:
      return new JsonFileStorage(config.storage.filePath);
  }
}
