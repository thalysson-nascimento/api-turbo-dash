import { createHash, verify } from "node:crypto";
import { z } from "zod";
import { db } from "./db";
import { ApiError, player, requestId, transaction } from "./api";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const adUnit = "ca-app-pub-8691674404508428/1406515156";
export function rewardDay(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
export async function dailyStatus(userId: string) {
  const day = rewardDay();
  const daily = await db.dailyAdReward.findUnique({ where: { userId_day: { userId, day } } });
  const pending = await db.adRewardAttempt.count({ where: { userId, day, transactionId: null, cancelled: false, expiresAt: { gt: new Date() } } });
  return { day, watched: daily?.watched ?? 0, remaining: Math.max(0, 5 - (daily?.watched ?? 0)), claimed: !!daily?.claimed, pending: pending > 0, player: await player(userId) };
}
export async function startDaily(userId: string, body: unknown) {
  const { requestId: id } = z.object({ requestId }).parse(body);
  const day = rewardDay();
  // Derive a reproducible opaque token for idempotent HTTP retries.
  // It is not proof of viewing: only Google's signed callback can credit it.
  const token = sha(`${userId}:${day}:${id}`);
  return transaction(async tx => {
    const daily = await tx.dailyAdReward.upsert({ where: { userId_day: { userId, day } }, create: { userId, day }, update: {} });
    if (daily.claimed) throw new ApiError(409, "Você já recebeu a recompensa de hoje.");
    const previous = await tx.adRewardAttempt.findUnique({ where: { tokenHash: sha(token) } });
    if (previous && !previous.cancelled && !previous.transactionId && previous.expiresAt > new Date()) return { token, day };
    if (previous) throw new ApiError(409, "Solicitação já encerrada.");
    const pending = await tx.adRewardAttempt.count({ where: { userId, day, transactionId: null, cancelled: false, expiresAt: { gt: new Date() } } });
    if (pending) throw new ApiError(409, "Aguarde a confirmação do anúncio anterior.");
    await tx.adRewardAttempt.create({ data: { tokenHash: sha(token), userId, day, expiresAt: new Date(Date.now() + 10*60*1000) } });
    return { token, day };
  });
}
export async function cancelDaily(userId: string, body: unknown) {
  const { token } = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).parse(body);
  await db.adRewardAttempt.updateMany({ where: { tokenHash: sha(token), userId, transactionId: null }, data: { cancelled: true } });
  return dailyStatus(userId);
}

let keyCache: { until: number, keys: Map<string, string> } | undefined;
async function googleKey(id: string) {
  if (!keyCache || keyCache.until < Date.now()) {
    const response = await fetch("https://www.gstatic.com/admob/reward/verifier-keys.json", { signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (!response.ok) throw new ApiError(503, "Verificação temporariamente indisponível.");
    const data = await response.json() as { keys: { keyId: number, pem: string }[] };
    keyCache = { until: Date.now() + 3600000, keys: new Map(data.keys.map(k => [String(k.keyId), k.pem])) };
  }
  const key = keyCache.keys.get(id);
  if (!key) { keyCache = undefined; throw new ApiError(503, "Chave de verificação em atualização."); }
  return key;
}
// Verify the original, percent-encoded query bytes; never reserialize parameters.
export function verifyQuery(raw: string, key: string) {
  const marker = raw.indexOf("&signature=");
  if (marker < 1 || !/^signature=[^&]+&key_id=\d+$/.test(raw.slice(marker+1))) return false;
  const parameters = new URLSearchParams(raw);
  if ([...parameters.keys()].some(k => parameters.getAll(k).length !== 1)) return false;
  try { return verify("sha256", Buffer.from(raw.slice(0,marker)), key, Buffer.from(parameters.get("signature")!, "base64url")); }
  catch { return false; }
}
export async function admobCallback(request: Request) {
  const url = new URL(request.url), raw = url.search.slice(1), p = url.searchParams;
  const keyId = p.get("key_id");
  if (!keyId || !/^\d+$/.test(keyId) || !p.has("signature")) throw new ApiError(400, "Callback inválido.");
  if (!verifyQuery(raw, await googleKey(keyId))) throw new ApiError(403, "Assinatura inválida.");
  // The AdMob console probe uses a placeholder unit and never grants currency.
  // Signature verification above is mandatory even for this no-op response.
  if (p.get("ad_unit") === "1234567890" && !p.get("custom_data")) return { ignored: true, test: true };
  if (p.get("ad_unit") !== adUnit && p.get("ad_unit") !== adUnit.split("/")[1]) throw new ApiError(403, "Unidade de anúncio inválida.");
  const token = p.get("custom_data");
  if (!token) return { ignored: true }; // Revive uses the same unit, with no daily reward token.
  if (!/^[a-f0-9]{64}$/.test(token)) throw new ApiError(400, "Recompensa inválida.");
  const transactionId = p.get("transaction_id"), timestamp = Number(p.get("timestamp"));
  if (!transactionId || transactionId.length>200 || !Number.isFinite(timestamp) || timestamp>Date.now()+60000) throw new ApiError(400, "Evento inválido.");
  await creditVerified(sha(token), transactionId, timestamp);
  return { success: true };
}
// Internal only: no client endpoint can submit a watched count or arbitrary credit.
export async function creditVerified(tokenHash: string, transactionId: string, timestamp: number) {
  return transaction(async tx => {
    const attempt = await tx.adRewardAttempt.findUnique({ where: { tokenHash } });
    if (!attempt) throw new ApiError(404, "Recompensa não encontrada.");
    if (attempt.transactionId === transactionId) return;
    if (attempt.transactionId || await tx.adRewardAttempt.findUnique({ where: { transactionId } })) throw new ApiError(409, "Evento já utilizado.");
    if (timestamp<attempt.createdAt.getTime()-60000 || timestamp>attempt.expiresAt.getTime()) throw new ApiError(400, "Evento fora do período do anúncio.");
    await tx.adRewardAttempt.update({ where: { tokenHash }, data: { transactionId } });
    const where = { userId_day: { userId: attempt.userId, day: attempt.day } };
    const daily = await tx.dailyAdReward.findUniqueOrThrow({ where });
    if (daily.claimed) return;
    const watched = Math.min(5, daily.watched+1), claimed = watched===5;
    await tx.dailyAdReward.update({ where, data: { watched, claimed } });
    if (claimed) {
      const result = await tx.wallet.updateMany({ where: { userId: attempt.userId, balance: { lte: 1999995000 } }, data: { balance: { increment: 5000 } } });
      if (!result.count) throw new ApiError(409, "Limite de saldo atingido.");
    }
  });
}
