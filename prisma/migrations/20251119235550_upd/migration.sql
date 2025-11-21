/*
  Warnings:

  - You are about to drop the `Chat` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Message` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterTable
ALTER TABLE "User" ADD COLUMN "tgID" TEXT;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Chat";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Message";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "tgChat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatData" JSONB
);

-- CreateTable
CREATE TABLE "tgMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatID" TEXT NOT NULL,
    "tgData" JSONB,
    CONSTRAINT "tgMessage_chatID_fkey" FOREIGN KEY ("chatID") REFERENCES "tgChat" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "tgChat_id_key" ON "tgChat"("id");

-- CreateIndex
CREATE UNIQUE INDEX "tgMessage_id_key" ON "tgMessage"("id");
