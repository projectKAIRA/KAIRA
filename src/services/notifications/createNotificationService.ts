import { NotificationService } from "./NotificationService.js";
import { SlackNotificationService } from "./SlackNotificationService.js";
import { TeamsNotificationService } from "./TeamsNotificationService.js";
import { POTracker } from "../po/POTracker.js";
import { config } from "../../config/index.js";

export function createNotificationService(tracker: POTracker): NotificationService {
  const provider = config.notification.provider;

  switch (provider) {
    case "slack": {
      const { botToken, poChannel, webhookRfq, webhookInquiry, botName } = config.notification.slack;
      if (!botToken) throw new Error("SLACK_BOT_TOKEN is required when NOTIFICATION_PROVIDER=slack");
      return new SlackNotificationService({ botToken, poChannel, webhookRfq, webhookInquiry, botName }, tracker);
    }

    case "teams": {
      const { webhookUrl } = config.notification.teams;
      if (!webhookUrl) throw new Error("TEAMS_WEBHOOK_URL is required when NOTIFICATION_PROVIDER=teams");
      return new TeamsNotificationService({ webhookUrl });
    }

    default:
      throw new Error(`Unknown NOTIFICATION_PROVIDER: "${provider}". Use "slack" or "teams".`);
  }
}
