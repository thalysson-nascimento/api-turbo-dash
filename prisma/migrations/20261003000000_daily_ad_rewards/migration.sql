CREATE TABLE "DailyAdReward" (
 "userId" TEXT NOT NULL, "day" TEXT NOT NULL, "watched" INTEGER NOT NULL DEFAULT 0, "claimed" BOOLEAN NOT NULL DEFAULT false,
 CONSTRAINT "DailyAdReward_pkey" PRIMARY KEY ("userId", "day"),
 CONSTRAINT "DailyAdReward_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "AdRewardAttempt" (
 "tokenHash" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "day" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "expiresAt" TIMESTAMP(3) NOT NULL,
 "cancelled" BOOLEAN NOT NULL DEFAULT false, "transactionId" TEXT,
 CONSTRAINT "AdRewardAttempt_userId_day_fkey" FOREIGN KEY ("userId", "day") REFERENCES "DailyAdReward"("userId", "day") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AdRewardAttempt_transactionId_key" ON "AdRewardAttempt"("transactionId");
CREATE INDEX "AdRewardAttempt_userId_day_idx" ON "AdRewardAttempt"("userId", "day");
UPDATE "Product" SET "duration" = 8, "description" = 'Atravesse o trânsito por 8 segundos.' WHERE "id" = 'ghost';
UPDATE "Product" SET "description" = 'Libera 50 metros da pista com uma onda de energia.' WHERE "id" = 'pulse';
