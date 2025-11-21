/*
  Warnings:

  - Added the required column `tgChatID` to the `tgChat` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_tgChat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tgChatID" TEXT NOT NULL,
    "chatData" JSONB
);
INSERT INTO "new_tgChat" ("chatData", "id") SELECT "chatData", "id" FROM "tgChat";
DROP TABLE "tgChat";
ALTER TABLE "new_tgChat" RENAME TO "tgChat";
CREATE UNIQUE INDEX "tgChat_id_key" ON "tgChat"("id");
CREATE UNIQUE INDEX "tgChat_tgChatID_key" ON "tgChat"("tgChatID");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
