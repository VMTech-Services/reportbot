const { exec } = require("child_process");
const prisma = require("../prisma");
const Director = require("../director");
const formatDate = require("../scripts/formatDate");

class UPSWatcher {
    static lastInternalId = null;
    static lastState = null;
    static intervalHandle = null;

    static log(...args) {
        console.log("[UPSWatcher]", ...args);
    }

    static getUpsName() {
        if (!process.env.NUTUPSNAME) {
            throw new Error("UPS name not specified in NUTUPSNAME env");
        }
        return process.env.NUTUPSNAME;
    }

    static execUpsCommand(cmd) {
        this.log("Executing command:", cmd);
        return new Promise((resolve, reject) => {
            exec(cmd, { timeout: 10_000 }, (err, stdout, stderr) => {
                if (err) {
                    this.log("Command error:", err.message || err);
                    return reject(err);
                }
                if (stderr) this.log("Command stderr:", stderr.trim());
                resolve(stdout ? stdout.trim() : "");
            });
        });
    }

    static async getUpsStatus() {
        try {
            const upsName = this.getUpsName();
            const statusRaw = await this.execUpsCommand(`upsc ${upsName}`);
            this.log("Raw UPS status:", statusRaw);
            const lines = statusRaw.split(/\r?\n/);
            const data = {};
            for (const line of lines) {
                if (!line.includes(":")) continue;
                const [key, ...rest] = line.split(":");
                const k = key?.trim();
                const v = rest.join(":").trim();
                if (k) data[k] = v;
            }
            this.log("Parsed UPS data:", data);
            if (Object.keys(data).length === 0) {
                throw new Error("Empty UPS status returned");
            }
            return data;
        } catch (err) {
            this.log("getUpsStatus error:", err);
            throw err;
        }
    }

    static async buildMessageFromLogs(internalMessageID) {
        if (!internalMessageID) return `No internal message id provided.`;
        try {
            const logs = await prisma.log.findMany({
                where: { internalMessageID },
                orderBy: { time: "asc" },
            });
            this.log(`Fetched ${logs.length} logs for internalMessageID ${internalMessageID}`);
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
        } catch (err) {
            this.log("buildMessageFromLogs error:", err);
            throw err;
        }
    }

    static async editMessageFromLogs(internalId) {
        if (!internalId) {
            this.log("editMessageFromLogs called without internalId");
            return null;
        }
        try {
            const text = await this.buildMessageFromLogs(internalId);
            if (typeof Director.editInternalMessage === "function") {
                await Director.editInternalMessage(internalId, text);
                this.log(`Edited internal message ${internalId}`);
            } else {
                this.log("Director.editInternalMessage is not a function");
            }
            return text;
        } catch (err) {
            this.log("editMessageFromLogs error:", err);
            return null;
        }
    }

    static async recordLog(action, data = {}, internalMessageID = null) {
        try {
            const rec = await prisma.log.create({
                data: { type: "ups", action, data, internalMessageID },
            });
            this.log(`Recorded log: ${action}, internalMessageID: ${internalMessageID}`);
            return rec;
        } catch (err) {
            this.log("recordLog failed:", err);
            return null;
        }
    }

    static _fmtVal(v, suffix = "") {
        if (v === null || typeof v === "undefined" || v === "") return `N/A`;
        return `${v}${suffix}`;
    }

    static _parseNumberRaw(v) {
        if (v === undefined || v === null) return null;
        const s = String(v).trim();
        const num = parseFloat(s.replace(/[^0-9.\-]/g, ""));
        return Number.isFinite(num) ? num : null;
    }

    static async createBroadcastForOutage(statusData) {
        this.log("Creating broadcast for power outage:", statusData);
        const now = new Date();
        const messageText =
            `🔴 ${process.env.DEPLOYNAME} — power outage detected!\n` +
            `Charge: ${this._fmtVal(statusData.charge, "%")} · Est. runtime: ${this._fmtVal(statusData.runtime, "s")}\n` +
            `Vin: ${this._fmtVal(statusData.inputVoltage, "V")} · Vout: ${this._fmtVal(statusData.outputVoltage, "V")} · Load: ${this._fmtVal(statusData.loadPct, "%")}\n` +
            `[${formatDate(now)}]`;

        const internalId = await Director.broadcastMessage(messageText);
        await this.recordLog("onbattery", statusData, internalId);
        this.lastInternalId = internalId;
        return internalId;
    }

    static async createBroadcastForRestore(statusData) {
        this.log("Creating broadcast for power restore:", statusData);
        const now = new Date();
        const messageText =
            `🟢 ${process.env.DEPLOYNAME} — power restored\n` +
            `Charge: ${this._fmtVal(statusData.charge, "%")} · Vin: ${this._fmtVal(statusData.inputVoltage, "V")} · Vout: ${this._fmtVal(statusData.outputVoltage, "V")}\n` +
            `[${formatDate(now)}]`;

        const internalId = await Director.broadcastMessage(messageText);
        await this.recordLog("online", statusData, internalId);
        this.lastInternalId = internalId;
        return internalId;
    }

    static async checkUps() {
        this.log("Starting UPS check...");
        try {
            const data = await this.getUpsStatus();
            const statusRaw = (data.status || "").toString();
            const tokens = statusRaw.split(/\s+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
            const isOnBattery = tokens.includes("OB") || (tokens.includes("DISCHRG") && !tokens.includes("OL"));
            const state = isOnBattery ? "onbattery" : "online";
            const statusData = {
                charge: this._parseNumberRaw(data["battery.charge"] ?? data["battery.charge.low"]),
                runtime: this._parseNumberRaw(data["battery.runtime"] ?? data["battery.runtime.low"]),
                inputVoltage: this._parseNumberRaw(data["input.voltage"]),
                outputVoltage: this._parseNumberRaw(data["output.voltage"]),
                loadPct: this._parseNumberRaw(data["ups.load"]),
                statusRaw
            };

            this.log("UPS statusData:", statusData, "Computed state:", state);

            if (this.lastState === null) {
                try {
                    const lastLog = await prisma.log.findFirst({ where: { type: "ups" }, orderBy: { time: "desc" } });
                    if (lastLog) {
                        this.lastState = lastLog.action === "onbattery" ? "onbattery" : "online";
                        this.lastInternalId = lastLog.internalMessageID || null;
                    } else this.lastState = state;
                    this.log("Initialized lastState:", this.lastState, "lastInternalId:", this.lastInternalId);
                } catch (e) {
                    this.log("Failed to read last log:", e);
                    this.lastState = state;
                }
            }

            if (state === "onbattery" && this.lastState !== "onbattery") {
                this.log("Transition detected: online -> onbattery");
                await this.createBroadcastForOutage(statusData);
            } else if (state === "online" && this.lastState === "onbattery") {
                this.log("Transition detected: onbattery -> online");
                await this.createBroadcastForRestore(statusData);
            } else {
                this.log("No state change, recording sample...");
                if (this.lastInternalId) {
                    await this.recordLog(state + "_sample", statusData, this.lastInternalId);
                    await this.editMessageFromLogs(this.lastInternalId);
                }
            }

            this.lastState = state;
        } catch (err) {
            this.log("checkUps error:", err);
        }
    }

    static async setup(intervalMs = 5000) {
        this.log("Setting up UPSWatcher...");
        try {
            const probe = await this.getUpsStatus();
            if (!probe || Object.keys(probe).length === 0) {
                this.log("Probe returned empty, not starting UPSWatcher");
                return false;
            }
        } catch (err) {
            this.log("Failed to probe UPS on startup:", err);
            return false;
        }

        try {
            const lastLog = await prisma.log.findFirst({ where: { type: "ups" }, orderBy: { time: "desc" } });
            if (lastLog) {
                this.lastState = lastLog.action === "onbattery" ? "onbattery" : "online";
                this.lastInternalId = lastLog.internalMessageID || null;
            }
            this.log("Initial lastState:", this.lastState, "lastInternalId:", this.lastInternalId);
        } catch (e) {
            this.log("Failed to read last log (continuing):", e);
        }

        try {
            await this.checkUps();
            this.intervalHandle = setInterval(() => this.checkUps(), intervalMs);
            this.log("UPSWatcher monitoring started, interval:", intervalMs);
            return true;
        } catch (e) {
            this.log("Failed to start periodic checks:", e);
            return false;
        }
    }
}

UPSWatcher.setup();

module.exports = UPSWatcher;
