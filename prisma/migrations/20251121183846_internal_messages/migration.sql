-- CreateTable
CREATE TABLE "InternalMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "content" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "InternalMessageTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "internalId" TEXT NOT NULL,
    "tgMessageId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InternalMessageTarget_internalId_fkey" FOREIGN KEY ("internalId") REFERENCES "InternalMessage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "InternalMessageTarget_tgMessageId_fkey" FOREIGN KEY ("tgMessageId") REFERENCES "tgMessage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "InternalMessage_key_key" ON "InternalMessage"("key");
