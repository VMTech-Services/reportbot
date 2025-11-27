// upsWatcher.js
const { exec } = require("child_process");
const prisma = require("../prisma");
const Director = require("../director");
const formatDate = require("../scripts/formatDate");

class UPSWatcher {
    static lastInternalId = null;
    static lastState = null;
    static intervalHandle = null;

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
            data[key.trim()] = rest.join(":").trim();
        }
        if (Object.keys(data).length === 0) {
            throw new Error("Empty UPS status returned");
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
            const time = formatDate(l.time);
            if (l.type === "ups") {
                const action =
                    l.action === "onbattery"
                        ? "🔴 power lost"
                        : l.action === "online"
                            ? "🟢 power restored"
                            : l.action;
                const extra = [];
                if (l.data) {
                    if (typeof l.data.charge !== "undefined") extra.push(`Charge: ${l.data.charge}%`);
                    if (typeof l.data.runtime !== "undefined") extra.push(`Runtime: ${l.data.runtime}s`);
                    if (typeof l.data.inputVoltage !== "undefined") extra.push(`Vin: ${l.data.inputVoltage}V`);
                    if (typeof l.data.outputVoltage !== "undefined") extra.push(`Vout: ${l.data.outputVoltage}V`);
                    if (typeof l.data.loadPct !== "undefined") extra.push(`Load: ${l.data.loadPct}%`);
                }
                const extras = extra.length > 0 ? ` — ${extra.join(", ")}` : "";
                return `${action}${extras}\n[${time}]`;
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

    static async createBroadcastForOutage(statusData) {
        const now = new Date();
        const { charge, runtime, inputVoltage, outputVoltage, loadPct } = statusData;
        const messageText = `🔴 ${process.env.DEPLOYNAME} — power outage detected!\n` +
            `Charge: ${charge}% · Est. runtime: ${runtime}s\n` +
            `Vin: ${inputVoltage}V · Vout: ${outputVoltage}V · Load: ${loadPct}%\n` +
            `[${formatDate(now)}]`;
        const internalId = await Director.broadcastMessage(messageText);
        await this.recordLog("onbattery", statusData, internalId);
        this.lastInternalId = internalId;
        return internalId;
    }

    static async createBroadcastForRestore(statusData) {
        const now = new Date();
        const { charge, inputVoltage, outputVoltage } = statusData;
        const messageText = `🟢 ${process.env.DEPLOYNAME} — power restored\n` +
            `Charge: ${charge}% · Vin: ${inputVoltage}V · Vout: ${outputVoltage}V\n` +
            `[${formatDate(now)}]`;
        const internalId = await Director.broadcastMessage(messageText);
        await this.recordLog("online", statusData, internalId);
        this.lastInternalId = internalId;
        return internalId;
    }

    static async checkUps() {
        try {
            const data = await this.getUpsStatus();

            const statusRaw = data.status || "";
            const tokens = statusRaw.split(/\s+/);
            const isOnBattery = tokens.includes("OB") || (tokens.includes("DISCHRG") && !tokens.includes("OL"));
            const state = isOnBattery ? "onbattery" : "online";

            const charge = parseFloat(data["battery.charge"] ?? data["battery.charge.low"] ?? 0) || 0;
            const runtime = parseFloat(data["battery.runtime"] ?? data["battery.runtime.low"] ?? 0) || 0;
            const inputVoltage = parseFloat(data["input.voltage"] ?? 0) || 0;
            const outputVoltage = parseFloat(data["output.voltage"] ?? 0) || 0;
            const loadPct = parseFloat(data["ups.load"] ?? 0) || 0;

            const statusData = { charge, runtime, inputVoltage, outputVoltage, loadPct };

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
                await this.createBroadcastForOutage(statusData);
            } else if (state === "online" && this.lastState === "onbattery") {
                await this.createBroadcastForRestore(statusData);
            } else {
                if (this.lastInternalId) {
                    await this.recordLog(state + "_sample", statusData, this.lastInternalId);
                    await this.editMessageFromLogs(this.lastInternalId);
                }
            }

            this.lastState = state;
        } catch (err) {
            console.error("UPSWatcher error during checkUps:", err);
        }
    }

    static async setup(intervalMs = 5000) {
        try {
            const probe = await this.getUpsStatus();
            if (!probe || Object.keys(probe).length === 0) {
                console.error("UPSWatcher: probe returned empty data — not starting UPSWatcher");
                return false;
            }
        } catch (err) {
            console.error("UPSWatcher: failed to probe UPS on startup — not starting UPSWatcher:", err.message || err);
            return false;
        }

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
            console.error("UPSWatcher: failed to read last log (continuing):", e);
        }

        try {
            await this.checkUps();
            this.intervalHandle = setInterval(() => this.checkUps(), intervalMs);
            console.log("UPSWatcher: monitoring started");
            return true;
        } catch (e) {
            console.error("UPSWatcher: failed to start periodic checks:", e);
            return false;
        }
    }
}

UPSWatcher.setup();

module.exports = UPSWatcher;