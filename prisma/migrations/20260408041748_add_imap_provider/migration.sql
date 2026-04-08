-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Tenant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "providerType" TEXT NOT NULL DEFAULT 'microsoft',
    "azureClientId" TEXT NOT NULL DEFAULT '',
    "azureClientSecret" TEXT NOT NULL DEFAULT '',
    "azureTenantId" TEXT NOT NULL DEFAULT 'consumers',
    "azureAuthMode" TEXT NOT NULL DEFAULT 'app_only',
    "userEmail" TEXT NOT NULL DEFAULT '',
    "inboxFolder" TEXT NOT NULL DEFAULT 'inbox',
    "pollIntervalSeconds" INTEGER NOT NULL DEFAULT 60,
    "imapHost" TEXT,
    "imapPort" INTEGER,
    "imapUser" TEXT,
    "imapPassword" TEXT,
    "imapSecure" BOOLEAN NOT NULL DEFAULT true,
    "notificationProvider" TEXT NOT NULL DEFAULT 'SLACK',
    "slackBotToken" TEXT,
    "slackSigningSecret" TEXT,
    "slackWebhookRfq" TEXT,
    "slackWebhookInquiry" TEXT,
    "slackPoChannelId" TEXT,
    "slackBotName" TEXT NOT NULL DEFAULT 'KAIRA',
    "teamsWebhookUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Tenant" ("azureAuthMode", "azureClientId", "azureClientSecret", "azureTenantId", "createdAt", "id", "inboxFolder", "isActive", "name", "notificationProvider", "pollIntervalSeconds", "slackBotName", "slackBotToken", "slackPoChannelId", "slackSigningSecret", "slackWebhookInquiry", "slackWebhookRfq", "teamsWebhookUrl", "updatedAt", "userEmail") SELECT "azureAuthMode", "azureClientId", "azureClientSecret", "azureTenantId", "createdAt", "id", "inboxFolder", "isActive", "name", "notificationProvider", "pollIntervalSeconds", "slackBotName", "slackBotToken", "slackPoChannelId", "slackSigningSecret", "slackWebhookInquiry", "slackWebhookRfq", "teamsWebhookUrl", "updatedAt", "userEmail" FROM "Tenant";
DROP TABLE "Tenant";
ALTER TABLE "new_Tenant" RENAME TO "Tenant";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
