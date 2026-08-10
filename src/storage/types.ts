/**
 * Storage contract.
 *
 * Railway containers are ephemeral, so nothing in the monitor may assume a
 * local file survives. The rest of the code only ever sees this interface;
 * swapping the JSON file for Redis, Postgres or a Railway Volume is a matter of
 * adding one implementation and changing `STATE_BACKEND`.
 */

export interface MonitorState {
  /** SHA-256 of the last availability that was notified. */
  fingerprint: string;
  /** ISO instant of the last notification actually sent. */
  notifiedAt: string;
  /** ISO instant of the last completed run (notified or not). */
  lastRunAt: string;
  /** Whether the last run found availability. */
  lastAvailable: boolean;
  /**
   * Runs completed since the last message was sent. Drives the periodic
   * summary: the monitor stays quiet while there is nothing new and speaks up
   * once this reaches `HEARTBEAT_EVERY_RUNS`.
   */
  runsSinceLastReport: number;
  /** Whether the previous run failed — used to report a *new* failure at once. */
  lastRunFailed: boolean;
  /** Short human summary, useful when inspecting the state by hand. */
  summary?: string;
}

export interface StateStorage {
  /** Returns the last stored state, or `null` on a first run. */
  getLastState(): Promise<MonitorState | null>;
  saveState(state: MonitorState): Promise<void>;
  /** Human-readable backend name, for logs. */
  readonly name: string;
}
