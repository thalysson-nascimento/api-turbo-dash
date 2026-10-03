import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { db } from "./db";

const scrypt = promisify(scryptCallback);
type Tx = Prisma.TransactionClient;
const include = { wallet: true, stats: true, inventory: true } as const;
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await db.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2034", "P2002"].includes(error.code) && attempt < 3) continue;
      throw error;
    }
  }
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function hashPassword(value: string) {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(value, salt, 64) as Buffer;
  return `${salt}:${key.toString("hex")}`;
}
async function verifyPassword(value: string, stored: string) {
  const [salt, hash] = stored.split(":");
  const key = await scrypt(value, salt, 64) as Buffer;
  const expected = Buffer.from(hash, "hex");
  return expected.length === key.length && timingSafeEqual(expected, key);
}
export async function player(userId: string, client: Tx | PrismaClient = db) {
  const user = await client.user.findUniqueOrThrow({ where: { id: userId }, include });
  return { id: user.id, name: user.name, initials: user.initials, avatar: user.avatar,
    bestScore: user.stats?.bestScore ?? 0, balance: user.wallet?.balance ?? 0,
    totalRuns: user.stats?.totalRuns ?? 0, totalDistance: user.stats?.totalDistance ?? 0,
    totalCoins: user.stats?.totalCoins ?? 0,
    inventory: user.inventory.map(({ itemId, quantity }) => ({ itemId, quantity })) };
}
export async function authenticate(request: Request) {
  const token = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) throw new ApiError(401, "Entre na sua conta para continuar.");
  const session = await db.session.findUnique({ where: { tokenHash: sha(token) } });
  if (!session || session.expiresAt <= new Date()) throw new ApiError(401, "Sua sessão expirou. Entre novamente.");
  return session;
}
async function newSession(userId: string, tx: Tx) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await tx.session.deleteMany({ where: { userId, expiresAt: { lt: new Date() } } });
  await tx.session.create({ data: { userId, tokenHash: sha(token), expiresAt } });
  return { token, expiresAt: expiresAt.toISOString(), player: await player(userId, tx) };
}
export async function limit(request: Request, scope: string, max: number, identifier = "") {
  // Never store IPs or emails in plaintext. Vercel supplies x-vercel-forwarded-for.
  const ip = request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const key = sha(`${scope}:${ip}:${identifier}`);
  await transaction(async tx => {
    const existing = await tx.rateLimit.findUnique({ where: { key } });
    if (!existing || existing.expiresAt <= new Date()) {
      await tx.rateLimit.upsert({ where: { key }, create: { key, expiresAt: new Date(Date.now() + 15 * 60 * 1000) }, update: { count: 1, expiresAt: new Date(Date.now() + 15 * 60 * 1000) } });
    } else {
      if (existing.count >= max) throw new ApiError(429, "Muitas tentativas. Aguarde 15 minutos.");
      await tx.rateLimit.update({ where: { key }, data: { count: { increment: 1 } } });
    }
  });
}
const email = z.email().max(254).transform(v => v.toLowerCase());
// Login verifies the stored hash, including administratively created test accounts.
// The eight-character minimum remains mandatory for public registration.
const credentials = z.object({ email, password: z.string().min(1).max(128) });
const registration = credentials.extend({ password: z.string().min(8).max(128), name: z.string().trim().min(1).max(16), initials: z.string().regex(/^[a-zA-Z]{3}$/).transform(v => v.toUpperCase()), avatar: z.enum(["boy", "girl"]) });
export async function register(request: Request, body: unknown) {
  const data = registration.parse(body);
  await limit(request, "register", 10);
  const passwordHash = await hashPassword(data.password);
  try {
    return await transaction(async tx => {
      const user = await tx.user.create({ data: { email: data.email, passwordHash, name: data.name, initials: data.initials, avatar: data.avatar, wallet: { create: {} }, stats: { create: {} } } });
      return newSession(user.id, tx);
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new ApiError(409, "Este e-mail já está cadastrado. Entre na sua conta.");
    throw error;
  }
}
export async function login(request: Request, body: unknown) {
  const data = credentials.parse(body);
  await limit(request, "login-ip", 60);
  await limit(request, "login-email", 15, data.email);
  const user = await db.user.findUnique({ where: { email: data.email } });
  // Use the same expensive password check when the email does not exist.
  const valid = await verifyPassword(data.password, user?.passwordHash ?? "00000000000000000000000000000000:" + "00".repeat(64));
  if (!user || !valid) throw new ApiError(401, "E-mail ou senha inválidos.");
  return transaction(tx => newSession(user.id, tx));
}
export const requestId = z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/);
export async function purchase(userId: string, body: unknown) {
  const { itemId, requestId: id } = z.object({ itemId: z.string().max(30), requestId }).parse(body);
  return transaction(async tx => {
    const previous = await tx.purchase.findUnique({ where: { userId_requestId: { userId, requestId: id } } });
    if (previous) {
      if (previous.itemId !== itemId) throw new ApiError(409, "Pedido já utilizado para outro item.");
      return { requestId: id, itemId, balance: previous.balance, quantity: previous.quantity, player: await player(userId, tx) };
    }
    const product = await tx.product.findUnique({ where: { id: itemId } });
    if (!product?.active) throw new ApiError(404, "Item indisponível.");
    const inventory = await tx.inventory.upsert({ where: { userId_itemId: { userId, itemId } }, create: { userId, itemId }, update: {} });
    if (inventory.quantity >= 999) throw new ApiError(409, "Limite do inventário atingido.");
    const debit = await tx.wallet.updateMany({ where: { userId, balance: { gte: product.price } }, data: { balance: { decrement: product.price } } });
    if (!debit.count) throw new ApiError(409, "Moedas insuficientes.");
    const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId } });
    const owned = await tx.inventory.update({ where: { userId_itemId: { userId, itemId } }, data: { quantity: { increment: 1 } } });
    await tx.purchase.create({ data: { userId, requestId: id, itemId, price: product.price, balance: wallet.balance, quantity: owned.quantity } });
    return { requestId: id, itemId, balance: wallet.balance, quantity: owned.quantity, player: await player(userId, tx) };
  });
}
export async function startRun(userId: string, body: unknown) {
  const { requestId: id } = z.object({ requestId }).parse(body);
  return transaction(async tx => {
    const previous = await tx.run.findUnique({ where: { userId_requestId: { userId, requestId: id } } });
    if (previous) {
      if (previous.endedAt) throw new ApiError(409, "Esta corrida já foi encerrada. Inicie outra.");
      return { runId: previous.id };
    }
    // Only one active race per account; stop an abandoned race before starting another.
    await tx.run.updateMany({ where: { userId, endedAt: null }, data: { endedAt: new Date() } });
    const run = await tx.run.create({ data: { userId, requestId: id } });
    await tx.playerStats.update({ where: { userId }, data: { totalRuns: { increment: 1 } } });
    return { runId: run.id };
  });
}
export async function checkpoint(userId: string, body: unknown) {
  const data = z.object({ runId: z.string().max(80), score: z.number().int().min(0).max(1_000_000), coins: z.number().int().min(0).max(100_000), finished: z.boolean().default(false) }).parse(body);
  return transaction(async tx => {
    const run = await tx.run.findFirst({ where: { id: data.runId, userId } });
    if (!run) throw new ApiError(404, "Corrida não encontrada.");
    if (run.endedAt) {
      if (data.score === run.score && data.coins === run.coins) return { player: await player(userId, tx) };
      throw new ApiError(409, "Esta corrida já foi encerrada.");
    }
    if (data.score < run.score || data.coins < run.coins) throw new ApiError(409, "Resultado anterior à última sincronização.");
    const seconds = (Date.now() - run.startedAt.getTime()) / 1000;
    if (data.score > seconds * 200 + 200 || data.coins > seconds * 60 + 60) throw new ApiError(422, "Resultado fora dos limites da corrida.");
    const coins = data.coins - run.coins, distance = data.score - run.score;
    const credited = await tx.wallet.updateMany({ where: { userId, balance: { lte: 2_000_000_000 - coins } }, data: { balance: { increment: coins } } });
    if (!credited.count) throw new ApiError(409, "Limite de saldo atingido.");
    await tx.run.update({ where: { id: run.id }, data: { score: data.score, coins: data.coins, endedAt: data.finished ? new Date() : null } });
    await tx.playerStats.update({ where: { userId }, data: { totalDistance: { increment: distance }, totalCoins: { increment: coins } } });
    await tx.playerStats.updateMany({ where: { userId, bestScore: { lt: data.score } }, data: { bestScore: data.score } });
    return { player: await player(userId, tx) };
  });
}
export async function consume(userId: string, body: unknown) {
  const { runId, itemId, requestId: id } = z.object({ runId: z.string().max(80), itemId: z.string().max(30), requestId }).parse(body);
  return transaction(async tx => {
    const run = await tx.run.findFirst({ where: { id: runId, userId } });
    if (!run) throw new ApiError(404, "Corrida não encontrada.");
    const previous = await tx.boosterUse.findUnique({ where: { runId_requestId: { runId, requestId: id } } });
    if (previous) {
      if (previous.itemId !== itemId) throw new ApiError(409, "Pedido já utilizado.");
      return { itemId, quantity: previous.quantity, player: await player(userId, tx) };
    }
    if (run.endedAt) throw new ApiError(409, "A corrida foi encerrada.");
    const changed = await tx.inventory.updateMany({ where: { userId, itemId, quantity: { gt: 0 } }, data: { quantity: { decrement: 1 } } });
    if (!changed.count) throw new ApiError(409, "Você não possui este item.");
    const owned = await tx.inventory.findUniqueOrThrow({ where: { userId_itemId: { userId, itemId } } });
    await tx.boosterUse.create({ data: { runId, itemId, requestId: id, quantity: owned.quantity } });
    return { itemId, quantity: owned.quantity, player: await player(userId, tx) };
  });
}
