import { PrismaClient } from "@prisma/client";
import { configureDatabaseEnv } from "../../scripts/database-env.mjs";
configureDatabaseEnv();
const globalDb = globalThis as unknown as { prisma?: PrismaClient };
export const db = globalDb.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalDb.prisma = db;
