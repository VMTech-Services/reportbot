// network.js
const https = require("https");
const prisma = require("../prisma");
const Director = require("../director");
const formatDate = require("../scripts/formatDate");

class NetworkWatcher {
    static INTERVAL = 5000;
    static REQUEST_TIMEOUT = 3000;
    static lastState = null;

    static checkInternetOnce() {
        return new Promise((resolve) => {
            const req = https.get(
                {
                    host: "1.1.1.1",
                    path: "/",
                    method: "GET",
                    timeout: this.REQUEST_TIMEOUT,
                },
                (res) => {
                    res.resume();
                    resolve(true);
                }
            );

            req.on("error", () => resolve(false));
            req.on("timeout", () => {
                req.destroy();
                resolve(false);
            });
        });
    }

    static async createLog(action, internalMessageID = null) {
        try {
            return await prisma.log.create({
                data: {
                    type: "network",
                    action,
                    internalMessageID,
                },
            });
        } catch (err) {
            console.error("NetworkWatcher: failed to write log:", err);
            return null;
        }
    }

    static async getLastLog() {
        try {
            return await prisma.log.findFirst({
                where: { type: "network" },
                orderBy: { time: "desc" },
            });
        } catch (err) {
            console.error("NetworkWatcher: failed to read last log:", err);
            return null;
        }
    }

    static async handleStateChange(isOnline) {
        const newState = isOnline ? "up" : "down";

        if (this.lastState === newState) return;

        const now = new Date();

        console.log(
            `NetworkWatcher: state changed ${this.lastState} -> ${newState} (${formatDate(
                now
            )})`
        );

        if (newState === "down") {
            await this.createLog("down");
            this.lastState = "down";
            return;
        }

        // newState === "up"
        const lastDown = await prisma.log.findFirst({
            where: { type: "network", action: "down" },
            orderBy: { time: "desc" },
        });

        let message;
        let internalId = null;

        if (lastDown) {
            const downDate = new Date(lastDown.time);
            const durationMs = now - downDate;

            const sec = Math.floor((durationMs / 1000) % 60);
            const min = Math.floor((durationMs / 60000) % 60);
            const hrs = Math.floor(durationMs / 3600000);

            const duration = [
                hrs ? `${hrs}h` : null,
                min ? `${min}m` : null,
                `${sec}s`,
            ]
                .filter(Boolean)
                .join(" ");

            message =
                `🟢 Internet restored\n` +
                `[${formatDate(now)}]\n\n` +
                `🔴 Was down since:\n` +
                `[${formatDate(downDate)}]\n` +
                `⏱ Duration: ${duration}`;
        } else {
            message = `🟢 Internet is up\n[${formatDate(now)}]`;
        }

        try {
            internalId = await Director.broadcastMessage(message);
        } catch (err) {
            console.error("NetworkWatcher: failed to broadcast:", err);
        }

        await this.createLog("up", internalId);
        this.lastState = "up";
    }

    static async start() {
        try {
            const lastLog = await this.getLastLog();
            this.lastState = lastLog ? lastLog.action : "up";

            console.log(
                "NetworkWatcher: starting, lastState =",
                this.lastState
            );

            const ok = await this.checkInternetOnce();
            await this.handleStateChange(ok);

            setInterval(async () => {
                try {
                    const ok = await this.checkInternetOnce();
                    await this.handleStateChange(ok);
                } catch (err) {
                    console.error("NetworkWatcher: periodic check error:", err);
                }
            }, this.INTERVAL);
        } catch (err) {
            console.error("NetworkWatcher: start failed:", err);
        }
    }
}

NetworkWatcher.start()
