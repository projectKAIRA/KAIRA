import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

let _client: PrismaClient | null = null;

export function getPrismaClient(): PrismaClient {
  if (!_client) {
    const url = process.env["DATABASE_URL"];
    if (!url) {
      throw new Error("Missing required environment variable: DATABASE_URL");
    }
    const adapter = new PrismaPg({ connectionString: url });
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
