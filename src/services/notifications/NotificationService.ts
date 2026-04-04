import { NotificationPayload, NotificationResult } from "../../types/index.js";

/**
 * Abstract notification contract.
 *
 * Swap Slack for Teams (or any other provider) by implementing this interface
 * and updating the NOTIFICATION_PROVIDER env variable — no other code changes.
 */
export interface NotificationService {
  /**
   * Send a structured notification about a processed email.
   * Returns a NotificationResult — for PO messages this includes the tracking
   * ID and Slack message coordinates needed for later updates (e.g. claiming).
   * Implementations should never throw; log errors and resolve gracefully.
   */
  send(payload: NotificationPayload): Promise<NotificationResult>;

  /** Human-readable name for logging. */
  readonly name: string;
}
