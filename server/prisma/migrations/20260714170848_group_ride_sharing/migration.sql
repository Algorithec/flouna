-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_GroupCart" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "domain" TEXT NOT NULL DEFAULT 'food',
    "platform" TEXT NOT NULL,
    "rideDetails" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "orderId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GroupCart_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_GroupCart" ("code", "createdAt", "hostId", "id", "orderId", "platform", "status", "updatedAt") SELECT "code", "createdAt", "hostId", "id", "orderId", "platform", "status", "updatedAt" FROM "GroupCart";
DROP TABLE "GroupCart";
ALTER TABLE "new_GroupCart" RENAME TO "GroupCart";
CREATE UNIQUE INDEX "GroupCart_code_key" ON "GroupCart"("code");
CREATE INDEX "GroupCart_hostId_idx" ON "GroupCart"("hostId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
