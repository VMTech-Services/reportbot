-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Chat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "tgChatID" TEXT
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatID" TEXT NOT NULL,
    "tgid" TEXT,
    CONSTRAINT "Message_chatID_fkey" FOREIGN KEY ("chatID") REFERENCES "Chat" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "DailyReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" DATETIME NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeeklyReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" DATETIME NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MonthlyReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" DATETIME NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "User_id_key" ON "User"("id");

-- CreateIndex
CREATE UNIQUE INDEX "Chat_id_key" ON "Chat"("id");

-- CreateIndex
CREATE UNIQUE INDEX "Message_id_key" ON "Message"("id");

-- CreateIndex
CREATE UNIQUE INDEX "DailyReport_date_key" ON "DailyReport"("date");

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyReport_date_key" ON "WeeklyReport"("date");

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyReport_date_key" ON "MonthlyReport"("date");
