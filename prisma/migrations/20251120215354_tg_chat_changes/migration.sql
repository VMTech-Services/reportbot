/*
  Warnings:

  - You are about to drop the `tgChat` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropIndex
DROP INDEX "tgChat_tgChatID_key";

-- DropIndex
DROP INDEX "tgChat_id_key";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "tgChat";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "tgChannel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tgChatID" TEXT NOT NULL,
    "addedOn" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settingsUpdates" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "chatData" JSONB
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_tgMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatID" TEXT NOT NULL,
    "tgData" JSONB,
    CONSTRAINT "tgMessage_chatID_fkey" FOREIGN KEY ("chatID") REFERENCES "tgChannel" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_tgMessage" ("chatID", "id", "tgData") SELECT "chatID", "id", "tgData" FROM "tgMessage";
DROP TABLE "tgMessage";
ALTER TABLE "new_tgMessage" RENAME TO "tgMessage";
CREATE UNIQUE INDEX "tgMessage_id_key" ON "tgMessage"("id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "tgChannel_id_key" ON "tgChannel"("id");

-- CreateIndex
CREATE UNIQUE INDEX "tgChannel_tgChatID_key" ON "tgChannel"("tgChatID");
