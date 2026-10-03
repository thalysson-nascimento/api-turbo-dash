import { admobCallback, dailyStatus, startDaily, cancelDaily } from "@/lib/ad-rewards";
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError, authenticate, checkpoint, consume, limit, login, player, purchase, register, startRun } from "@/lib/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const origins = () => (process.env.ALLOWED_ORIGINS ?? "").split(",").map(s => s.trim());
function headers(request: Request) {
  const result = new Headers({ "Cache-Control": "no-store", "Vary": "Origin" });
  const origin = request.headers.get("origin");
  if (origin && origins().includes(origin)) {
    result.set("Access-Control-Allow-Origin", origin);
    result.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    result.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
  return result;
}
export async function OPTIONS(request: Request) { return new Response(null, { status: 204, headers: headers(request) }); }
async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const path = (await context.params).path.join("/");
    const method = request.method;
    const origin = request.headers.get("origin");
    if (origin && !origins().includes(origin)) throw new ApiError(403, "Origem não autorizada.");
    let body: unknown;
    if (method === "POST") {
      if (!request.headers.get("content-type")?.includes("application/json")) throw new ApiError(415, "Envie application/json.");
      const text = await request.text();
      if (text.length > 16384) throw new ApiError(413, "Corpo muito grande.");
      try { body = JSON.parse(text); } catch { throw new ApiError(400, "JSON inválido."); }
    }
    let result: unknown;
    let status = 200;
    if (method === "GET" && path === "health") { await db.$queryRaw`SELECT 1`; result = { status: "ok" }; }
    else if (method === "GET" && path === "ads/admob/ssv") result = await admobCallback(request);
    else if (method === "POST" && path === "auth/register") { result = await register(request, body); status = 201; }
    else if (method === "POST" && path === "auth/login") result = await login(request, body);
    else if (method === "GET" && path === "store") result = { items: await db.product.findMany({ where: { active: true }, orderBy: { art: "asc" } }), coinPacks: [5000, 10000, 25000, 50000] };
    else if (method === "GET" && path === "ranking") {
      const top = await db.playerStats.findMany({ where: { bestScore: { gt: 0 } }, take: 10, orderBy: [{ bestScore: "desc" }, { userId: "asc" }], include: { user: true } });
      result = { entries: top.map((s, i) => ({ rank: i + 1, playerId: s.userId, initials: s.user.initials, name: s.user.name, avatar: s.user.avatar, score: s.bestScore })) };
    } else {
      const session = await authenticate(request);
      await limit(request, "player", 500, session.userId);
      if (method === "GET" && path === "me") result = { player: await player(session.userId) };
      else if (method === "POST" && path === "auth/logout") { await db.session.deleteMany({ where: { id: session.id } }); result = { success: true }; }
      else if (method === "GET" && path === "rewards/daily") result = await dailyStatus(session.userId);
      else if (method === "POST" && path === "rewards/daily/start") result = await startDaily(session.userId, body);
      else if (method === "POST" && path === "rewards/daily/cancel") result = await cancelDaily(session.userId, body);
      else if (method === "POST" && path === "store/purchases") result = await purchase(session.userId, body);
      else if (method === "POST" && path === "runs/start") result = await startRun(session.userId, body);
      else if (method === "POST" && path === "runs/checkpoint") result = await checkpoint(session.userId, body);
      else if (method === "POST" && path === "inventory/consume") result = await consume(session.userId, body);
      else throw new ApiError(404, "Endpoint não encontrado.");
    }
    return Response.json(result, { status, headers: headers(request) });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : error instanceof z.ZodError ? 400 : 500;
    const message = error instanceof ApiError ? error.message : error instanceof z.ZodError ? "Campos inválidos. Confira nome, iniciais, e-mail, senha e valores enviados." : "Não foi possível concluir a operação.";
    if (status === 500) console.error("API operation failed", error instanceof Error ? error.name : "unknown");
    return Response.json({ error: message }, { status, headers: headers(request) });
  }
}
export const GET = handle;
export const POST = handle;
