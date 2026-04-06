import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";

// Prisma 7 requires an explicit driver adapter for SQLite.
// DATABASE_URL should be a "file:..." path, e.g. "file:./prisma/dev.db"

function getDbUrl(): string {
  return process.env["DATABASE_URL"] ?? "file:./prisma/dev.db"; // relative to process.cwd()
}

let _client: PrismaClient | null = null;

export function getPrismaClient(): PrismaClient {
  if (!_client) {
    const adapter = new PrismaBetterSqlite3({ url: getDbUrl() });
    _client = new PrismaClient({ adapter });
  }
  return _client;
}

export async function disconnectPrisma(): Promise<void> {
  if (_client) {
    await _client.$disconnect();
    _client = null;
  }
}
