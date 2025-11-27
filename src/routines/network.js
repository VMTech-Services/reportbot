// network.js
const dns = require("dns");
const prisma = require("../prisma");
const Director = require("../director");
const formatDate = require("../scripts/formatDate");

class NetworkWatcher {
    static isDown = false;
    static outageStart = null;
    static lastInternalId = null;

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
        this.outageStart = new Date();

        await this.record("down");

        console.log(`NetworkWatcher: internet LOST at ${this.outageStart}`);
    }

    static async handleUp() {
        if (!this.isDown) return;

        const restoredAt = new Date();

        const msg = `🌐 Internet connection restored\n` +
            `🔴 Lost: [${formatDate(this.outageStart.toISOString())}]\n` +
            `🟢 Restored: [${formatDate(restoredAt.toISOString())}]`;

        const internalId = await Director.broadcastMessage(msg);

        await this.record("up", internalId);

        console.log("NetworkWatcher: internet restored");

        this.isDown = false;
        this.outageStart = null;
        this.lastInternalId = internalId;
    }

    static start(interval = 5000) {
        console.log("NetworkWatcher: monitoring started");

        setInterval(async () => {
            const online = await this.checkInternet();

            if (!online) {
                await this.handleDown();
            } else {
                await this.handleUp();
            }
        }, interval);
    }
}

module.exports = NetworkWatcher;

NetworkWatcher.start();
