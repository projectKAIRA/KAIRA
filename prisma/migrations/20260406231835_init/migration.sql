-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "azureClientId" TEXT NOT NULL,
    "azureClientSecret" TEXT NOT NULL,
    "azureTenantId" TEXT NOT NULL DEFAULT 'consumers',
    "inboxFolder" TEXT NOT NULL DEFAULT 'inbox',
    "pollIntervalSeconds" INTEGER NOT NULL DEFAULT 60,
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

-- CreateTable
CREATE TABLE "TrackedOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNCLAIMED',
    "purchaseOrderJson" TEXT NOT NULL,
    "emailJson" TEXT NOT NULL,
    "pdfBase64" TEXT NOT NULL,
    "pdfName" TEXT NOT NULL,
    "claimedBy" TEXT,
    "claimedByName" TEXT,
    "claimedAt" DATETIME,
    "slackMessageTs" TEXT,
    "slackChannelId" TEXT,
    "receivedAt" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrackedOrder_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeltaLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "folderName" TEXT NOT NULL,
    "deltaLink" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DeltaLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TrackedOrder_tenantId_idx" ON "TrackedOrder"("tenantId");

-- CreateIndex
CREATE INDEX "TrackedOrder_tenantId_status_idx" ON "TrackedOrder"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DeltaLink_tenantId_folderName_key" ON "DeltaLink"("tenantId", "folderName");
