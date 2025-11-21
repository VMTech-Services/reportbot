/*
  Warnings:

  - You are about to drop the `InternalMessageTarget` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the column `key` on the `InternalMessage` table. All the data in the column will be lost.
  - Added the required column `internalMessageID` to the `Log` table without a default value. This is not possible if the table is not empty.
  - Added the required column `internalMsgID` to the `tgMessage` table without a default value. This is not possible if the table is not empty.

*/
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "InternalMessageTarget";
PRAGMA foreign_keys=on;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_InternalMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
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
    "data" JSONB NOT NULL,
    "time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "internalMessageID" TEXT NOT NULL,
    CONSTRAINT "Log_internalMessageID_fkey" FOREIGN KEY ("internalMessageID") REFERENCES "InternalMessage" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Log" ("action", "data", "id", "time", "type") SELECT "action", "data", "id", "time", "type" FROM "Log";
DROP TABLE "Log";
ALTER TABLE "new_Log" RENAME TO "Log";
CREATE TABLE "new_tgMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatID" TEXT NOT NULL,
    "internalMsgID" TEXT NOT NULL,
    "tgData" JSONB,
    CONSTRAINT "tgMessage_chatID_fkey" FOREIGN KEY ("chatID") REFERENCES "tgChannel" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "tgMessage_internalMsgID_fkey" FOREIGN KEY ("internalMsgID") REFERENCES "InternalMessage" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_tgMessage" ("chatID", "id", "tgData") SELECT "chatID", "id", "tgData" FROM "tgMessage";
DROP TABLE "tgMessage";
ALTER TABLE "new_tgMessage" RENAME TO "tgMessage";
CREATE UNIQUE INDEX "tgMessage_id_key" ON "tgMessage"("id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
