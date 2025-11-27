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
                resolve(stdout ? stdout.trim() : "");
            });
        });
    }

    static async getUpsStatus() {
        const upsName = this.getUpsName();
        const statusRaw = await this.execUpsCommand(`upsc ${upsName}`);
        const lines = statusRaw.split(/\r?\n/);
        const data = {};
        for (const line of lines) {
            if (!line.includes(":")) continue;
            const [key, ...rest] = line.split(":");
            const k = key?.trim();
            const v = rest.join(":").trim();
            if (k) data[k] = v;
        }
        if (Object.keys(data).length === 0) {
            throw new Error("Empty UPS status returned");
        }
        return data;
    }

    static async buildMessageFromLogs(internalMessageID) {
        if (!internalMessageID) return `No internal message id provided.`;
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

    static async editMessageFromLogs(internalId) {
        if (!internalId) {
            console.warn("editMessageFromLogs called without internalId");
            return null;
        }

        try {
            const text = await this.buildMessageFromLogs(internalId);

            if (typeof Director.editInternalMessage === "function") {
                await Director.editInternalMessage(internalId, text);
            } else {
                console.warn("Director.editInternalMessage is not a function; cannot edit messages.");
            }

            return text;
        } catch (err) {
            console.error("editMessageFromLogs error:", err);
            // don't rethrow — we want checkUps to continue running
            return null;
        }
    }

    static async recordLog(action, data = {}, internalMessageID = null) {
        try {
            const rec = await prisma.log.create({
                data: {
                    type: "ups",
                    action,
                    data,
                    internalMessageID,
                },
            });
            return rec;
        } catch (err) {
            console.error("recordLog failed:", err);
            return null;
        }
    }

    static _fmtVal(v, suffix = "") {
        if (v === null || typeof v === "undefined" || v === "") return `N/A`;
        return `${v}${suffix}`;
    }

    static async createBroadcastForOutage(statusData) {
        const now = new Date();
        const charge = statusData.charge ?? "N/A";
        const runtime = statusData.runtime ?? "N/A";
        const inputVoltage = statusData.inputVoltage ?? "N/A";
        const outputVoltage = statusData.outputVoltage ?? "N/A";
        const loadPct = statusData.loadPct ?? "N/A";

        const messageText =
            `🔴 ${process.env.DEPLOYNAME} — power outage detected!\n` +
            `Charge: ${this._fmtVal(charge, "%")} · Est. runtime: ${this._fmtVal(runtime, "s")}\n` +
            `Vin: ${this._fmtVal(inputVoltage, "V")} · Vout: ${this._fmtVal(outputVoltage, "V")} · Load: ${this._fmtVal(loadPct, "%")}\n` +
            `[${formatDate(now)}]`;

        const internalId = await Director.broadcastMessage(messageText);
        await this.recordLog("onbattery", statusData, internalId);
        this.lastInternalId = internalId;
        return internalId;
    }

    static async createBroadcastForRestore(statusData) {
        const now = new Date();
        const charge = statusData.charge ?? "N/A";
        const inputVoltage = statusData.inputVoltage ?? "N/A";
        const outputVoltage = statusData.outputVoltage ?? "N/A";

        const messageText =
            `🟢 ${process.env.DEPLOYNAME} — power restored\n` +
            `Charge: ${this._fmtVal(charge, "%")} · Vin: ${this._fmtVal(inputVoltage, "V")} · Vout: ${this._fmtVal(outputVoltage, "V")}\n` +
            `[${formatDate(now)}]`;

        const internalId = await Director.broadcastMessage(messageText);
        await this.recordLog("online", statusData, internalId);
        this.lastInternalId = internalId;
        return internalId;
    }

    static _parseNumberRaw(v) {
        if (v === undefined || v === null) return null;
        const s = String(v).trim();
        const num = parseFloat(s.replace(/[^0-9.\-]/g, ""));
        return Number.isFinite(num) ? num : null;
    }

    static async checkUps() {
        try {
            const data = await this.getUpsStatus();

            const statusRaw = (data.status || "").toString();
            const tokens = statusRaw
                .split(/\s+/)
                .map((t) => t.trim().toUpperCase())
                .filter(Boolean);

            const isOnBattery = tokens.includes("OB") || (tokens.includes("DISCHRG") && !tokens.includes("OL"));
            const state = isOnBattery ? "onbattery" : "online";

            const charge = this._parseNumberRaw(data["battery.charge"] ?? data["battery.charge.low"]);
            const runtime = this._parseNumberRaw(data["battery.runtime"] ?? data["battery.runtime.low"]);
            const inputVoltage = this._parseNumberRaw(data["input.voltage"]);
            const outputVoltage = this._parseNumberRaw(data["output.voltage"]);
            const loadPct = this._parseNumberRaw(data["ups.load"]);

            const statusData = { charge, runtime, inputVoltage, outputVoltage, loadPct, statusRaw };

            // init last state from last DB log if needed
            if (this.lastState === null) {
                try {
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
                } catch (e) {
                    console.error("UPSWatcher: failed to read last log (continuing):", e);
                    this.lastState = state;
                }
            }

            // transitions
            if (state === "onbattery" && this.lastState !== "onbattery") {
                await this.createBroadcastForOutage(statusData);
            } else if (state === "online" && this.lastState === "onbattery") {
                await this.createBroadcastForRestore(statusData);
            } else {
                // samples / keep-alive updates
                if (this.lastInternalId) {
                    try {
                        await this.recordLog(state + "_sample", statusData, this.lastInternalId);
                    } catch (rErr) {
                        console.error("Failed to record UPS sample log:", rErr);
                    }

                    try {
                        // safe edit
                        await this.editMessageFromLogs(this.lastInternalId);
                    } catch (e) {
                        // already handled inside editMessageFromLogs, but keep safe guard
                        console.error("Failed to edit internal message from logs:", e);
                    }
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
