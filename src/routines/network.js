// network.js
const dns = require("dns");
const prisma = require("../prisma");
const Director = require("../director");
const formatDate = require("../scripts/formatDate");

class NetworkWatcher {
    static isDown = false;
    static outageStart = null;
    static lastInternalId = null;
    static intervalHandle = null;

    static checkInternet() {
        return new Promise((resolve) => {
            dns.resolve("google.com", (err) => {
                resolve(!err);
            });
        });
    }

    static async record(action, internalMessageID = null) {
        return prisma.log.create({
            data: {
                type: "network",
                action,
                internalMessageID
            }
        });
    }

    static async handleDown() {
        if (this.isDown) return;

        this.isDown = true;
        if (!this.outageStart) {
            this.outageStart = new Date();
        }

        await this.record("down", this.lastInternalId);

        console.log(`NetworkWatcher: internet LOST at ${formatDate(this.outageStart)}`);
    }

    static async handleUp() {
        if (!this.isDown) return;

        const restoredAt = new Date();

        const msg = `🌐 Internet connection restored\n` +
            `🔴 Lost: [${formatDate(this.outageStart)}]\n` +
            `🟢 Restored: [${formatDate(restoredAt)}]`;

        const internalId = await Director.broadcastMessage(msg);

        await this.record("up", internalId);

        console.log("NetworkWatcher: internet restored");

        this.isDown = false;
        this.outageStart = null;
        this.lastInternalId = internalId;
    }

    static async start(interval = 5000) {
        console.log("NetworkWatcher: initializing...");

        try {
            const lastLog = await prisma.log.findFirst({
                where: { type: "network" },
                orderBy: { time: "desc" },
            });

            if (lastLog) {
                if (lastLog.action === "down") {
                    this.isDown = true;
                    this.outageStart = new Date(lastLog.time);
                    this.lastInternalId = lastLog.internalMessageID || null;
                    console.log("NetworkWatcher: restored state from last log -> DOWN since", formatDate(this.outageStart));
                } else {
                    this.isDown = false;
                    this.outageStart = null;
                    this.lastInternalId = lastLog.internalMessageID || null;
                    console.log("NetworkWatcher: restored state from last log -> UP");
                }
            } else {
                console.log("NetworkWatcher: no previous network logs found, starting fresh");
            }
        } catch (err) {
            console.error("NetworkWatcher: failed to read last log (continuing):", err);
        }

        try {
            const online = await this.checkInternet();
            if (!online) {
                await this.handleDown();
            } else {
                await this.handleUp();
            }
        } catch (err) {
            console.error("NetworkWatcher: initial check failed:", err);
        }

        this.intervalHandle = setInterval(async () => {
            try {
                const online = await this.checkInternet();
                if (!online) {
                    await this.handleDown();
                } else {
                    await this.handleUp();
                }
            } catch (err) {
                console.error("NetworkWatcher: periodic check error:", err);
            }
        }, interval);

        console.log("NetworkWatcher: monitoring started");
    }

    static stop() {
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
            console.log("NetworkWatcher: stopped");
        }
    }
}

NetworkWatcher.start();
