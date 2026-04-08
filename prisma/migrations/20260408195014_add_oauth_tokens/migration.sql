-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN "azureAccessToken" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "azureRefreshToken" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "azureTokenExpiresAt" DATETIME;
