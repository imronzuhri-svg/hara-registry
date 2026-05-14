import Redis from "ioredis";

export function createRedis(): Redis {
  return new Redis({
    host: process.env.REDIS_HOST ?? "redis",
    port: Number(process.env.REDIS_PORT ?? 6379),
    maxRetriesPerRequest: null, // long-lived consumer connections
    enableReadyCheck: true,
  });
}
