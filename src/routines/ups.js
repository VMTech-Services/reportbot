// upsWatcher.js
const { exec } = require("child_process");
const prisma = require("../prisma");
const Director = require("../director");
const formatDate = require("../scripts/formatDate");

class UPSWatcher {
    static lastInternalId = null;
    static lastState = null;

    static getUpsName() {
        if (!process.env.NUTUPSNAME) {
            throw new Error("UPS name not specified in NUTUPSNAME env");
        }
        return process.env.NUTUPSNAME;
    }

    static execUpsCommand(cmd) {
        return new Promise((resolve, reject) => {
            exec(cmd, { timeout: 10_000 }, (err, stdout, stderr) => {
                if (err) return reject(err);
                resolve(stdout.trim());
            });
        });
    }

    static async getUpsStatus() {
        const upsName = this.getUpsName();
        const statusRaw = await this.execUpsCommand(`upsc ${upsName}`);
        const lines = statusRaw.split("\n");
        const data = {};
        for (const line of lines) {
            const [key, ...rest] = line.split(":");
            if (!key) continue;
            const value = rest.join(":").trim();
            data[key.trim()] = value;
        }
        return data;
    }

    static async buildMessageFromLogs(internalMessageID) {
        const logs = await prisma.log.findMany({
            where: { internalMessageID },
            orderBy: { time: "asc" },
        });

        const header = `🔔 ${process.env.DEPLOYNAME} UPS history\n\n`;
        const lines = logs.map((l) => {
            const time = formatDate(l.time.toISOString ? l.time.toISOString() : new Date(l.time).toISOString());
            if (l.type === "ups") {
                const action = l.action === "onbattery" ? "🔴 power lost" :
                    l.action === "online" ? "🟢 power restored" : l.action;
                const charge = l.data && typeof l.data.charge !== "undefined" ? ` — Charge: ${l.data.charge}%` : "";
                return `${action} ${charge}\n[${time}]`;
            } else {
                return `${l.action}\n[${time}]`;
            }
        });

        return header + lines.join("\n\n");
    }

    static async recordLog(action, data = {}, internalMessageID = null) {
        const rec = await prisma.log.create({
            data: {
                type: "ups",
                action,
                data,
                internalMessageID,
            },
        });
        return rec;
    }

    static async createBroadcastForOutage(charge, minCharge) {
        const now = new Date();
        const messageText = `🔴 ${process.env.DEPLOYNAME} power outage detected!\nCharge: ${charge}% / min ${minCharge}%\n[${formatDate(now.toISOString())}]`;
        const internalId = await Director.broadcastMessage(messageText);
        await this.recordLog("onbattery", { charge, minCharge }, internalId);
        this.lastInternalId = internalId;
        return internalId;
    }

    static async editMessageFromLogs(internalId) {
        const text = await this.buildMessageFromLogs(internalId);
        await Director.editInternalMessage(internalId, text);
        return text;
    }

    static async checkUps() {
        try {
            const data = await this.getUpsStatus();
            const state = data.status === "OB" ? "onbattery" : "online";
            const charge = parseFloat(data["battery.charge"] ?? data["battery.charge.low"] ?? 0) || 0;
            const minCharge = parseFloat(data["battery.runtime.low"] ?? data["battery.runtime"] ?? 0) || 0;
            const now = new Date();

            if (this.lastState === null) {
                const lastLog = await prisma.log.findFirst({
                    where: { type: "ups" },
                    orderBy: { time: "desc" },
                });
                if (lastLog) {
                    this.lastState = lastLog.action === "onbattery" ? "onbattery" : "online";
                    this.lastInternalId = lastLog.internalMessageID || null;
                } else {
                    this.lastState = state;
                }
            }

            if (state === "onbattery" && this.lastState !== "onbattery") {
                if (!this.lastInternalId) {
                    await this.createBroadcastForOutage(charge, minCharge);
                } else {
                    if (Math.round(charge) < 100) {
                        await this.recordLog("onbattery", { charge, minCharge }, this.lastInternalId);
                        await this.editMessageFromLogs(this.lastInternalId);
                    } else {
                        await this.createBroadcastForOutage(charge, minCharge);
                    }
                }
            }

            else if (state === "online" && this.lastState === "onbattery") {
                if (this.lastInternalId) {
                    await this.recordLog("online", { charge, minCharge }, this.lastInternalId);
                    await this.editMessageFromLogs(this.lastInternalId);
                } else {
                    const messageText = `🟢 ${process.env.DEPLOYNAME} power restored\nCharge: ${charge}%\n[${formatDate(now.toISOString())}]`;
                    const internalId = await Director.broadcastMessage(messageText);
                    await this.recordLog("online", { charge, minCharge }, internalId);
                    this.lastInternalId = internalId;
                }
            }

            else if (state === "onbattery" && this.lastState === "onbattery") {
                if (this.lastInternalId) {
                    await this.recordLog("onbattery_sample", { charge, minCharge }, this.lastInternalId);
                    await this.editMessageFromLogs(this.lastInternalId);
                }
            }

            if (!(state === "onbattery" && this.lastState !== "onbattery") &&
                !(state === "online" && this.lastState === "onbattery")) {
                await this.recordLog(state, { charge, minCharge }, this.lastInternalId);
            }

            this.lastState = state;
        } catch (err) {
            console.error("UPSWatcher error:", err);
        }
    }

    static setup(intervalMs = 5000) {
        console.log("UPSWatcher: monitoring started");
        (async () => {
            try {
                const lastLog = await prisma.log.findFirst({
                    where: { type: "ups" },
                    orderBy: { time: "desc" },
                });
                if (lastLog) {
                    this.lastState = lastLog.action === "onbattery" ? "onbattery" : "online";
                    this.lastInternalId = lastLog.internalMessageID || null;
                }
            } catch (e) {
            }
            await this.checkUps();
            setInterval(() => this.checkUps(), intervalMs);
        })().catch((e) => console.error("UPSWatcher init error:", e));
    }
}

module.exports = UPSWatcher;
