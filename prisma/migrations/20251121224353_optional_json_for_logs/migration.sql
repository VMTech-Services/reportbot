-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_InternalMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "content" JSONB
);
INSERT INTO "new_InternalMessage" ("content", "createdAt", "id", "updatedAt") SELECT "content", "createdAt", "id", "updatedAt" FROM "InternalMessage";
DROP TABLE "InternalMessage";
ALTER TABLE "new_InternalMessage" RENAME TO "InternalMessage";
CREATE UNIQUE INDEX "InternalMessage_id_key" ON "InternalMessage"("id");
CREATE TABLE "new_Log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "data" JSONB,
    "time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "internalMessageID" TEXT NOT NULL,
    CONSTRAINT "Log_internalMessageID_fkey" FOREIGN KEY ("internalMessageID") REFERENCES "InternalMessage" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Log" ("action", "data", "id", "internalMessageID", "time", "type") SELECT "action", "data", "id", "internalMessageID", "time", "type" FROM "Log";
DROP TABLE "Log";
ALTER TABLE "new_Log" RENAME TO "Log";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
