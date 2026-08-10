import type { MonitorState, StateStorage } from './types.js';

/**
 * In-memory storage. Useful for tests and for `DRY_RUN` experiments where
 * persisting anything would be noise. On Railway without a Volume this means
 * every run is treated as new — set a durable backend if that matters.
 */
export class MemoryStorage implements StateStorage {
  readonly name = 'memory';
  private state: MonitorState | null = null;

  constructor(initial: MonitorState | null = null) {
    this.state = initial;
  }

  async getLastState(): Promise<MonitorState | null> {
    return this.state;
  }

  async saveState(state: MonitorState): Promise<void> {
    this.state = state;
  }
}
