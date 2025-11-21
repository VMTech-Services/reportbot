/*
  Warnings:

  - You are about to drop the column `tgID` on the `User` table. All the data in the column will be lost.

*/
-- CreateTable
CREATE TABLE "TgAccount" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "TgAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_User" ("createdAt", "id", "isAdmin", "password", "username") SELECT "createdAt", "id", "isAdmin", "password", "username" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_id_key" ON "User"("id");
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "TgAccount_tgId_key" ON "TgAccount"("tgId");
