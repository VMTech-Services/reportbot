-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "data" JSONB,
    "time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "internalMessageID" TEXT,
    CONSTRAINT "Log_internalMessageID_fkey" FOREIGN KEY ("internalMessageID") REFERENCES "InternalMessage" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Log" ("action", "data", "id", "internalMessageID", "time", "type") SELECT "action", "data", "id", "internalMessageID", "time", "type" FROM "Log";
DROP TABLE "Log";
ALTER TABLE "new_Log" RENAME TO "Log";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
