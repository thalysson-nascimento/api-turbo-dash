export function configureDatabaseEnv(env = process.env) {
  const url = env.PRISMA_DATABASE_URL || env.POSTGRES_URL || env.DATABASE_URL;
  if (url) env.DATABASE_URL = url;
  return url;
}
