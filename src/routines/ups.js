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
        if (!process.env.NUTUPSNAME) throw new Error("UPS name not specified in NUTUPSNAME env");
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
            if (Object.keys(data).length === 0) throw new Error("Empty UPS status returned");
            return data;
        } catch (err) {
            this.log("getUpsStatus error:", err);
            throw err;
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

    static async createBroadcastForOutage(statusData) {
        this.log("Creating broadcast for power outage:", statusData);
        const now = new Date();
        const messageText =
            `🔴 ${process.env.DEPLOYNAME} — power outage detected!\n` +
            `Charge: ${this._fmtVal(statusData.charge, "%")} · Est. runtime: ${this._fmtVal(statusData.runtime, "s")}\n` +
            `Vin: ${this._fmtVal(statusData.inputVoltage, "V")} · Vout: ${this._fmtVal(statusData.outputVoltage, "V")} · Load: ${this._fmtVal(statusData.loadPct, "%")}\n` +
            `[${formatDate(now)}]`;
        const internalId = await Director.broadcastMessage(messageText);
        await this.recordLog("loss", statusData, internalId);
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

    static async createBroadcastForLow(statusData) {
        this.log("Battery low warning (low):", statusData);
        const now = new Date();
        const messageText =
            `⚠️ ${process.env.DEPLOYNAME} — battery low!\n` +
            `Charge: ${this._fmtVal(statusData.charge, "%")} · Est. runtime: ${this._fmtVal(statusData.runtime, "s")}\n` +
            `[${formatDate(now)}]`;
        const internalId = await Director.broadcastMessage(messageText);
        await this.recordLog("low", statusData, internalId);
        this.lastInternalId = internalId;
        return internalId;
    }

    static async createBroadcastForDown(statusData) {
        this.log("Battery critical down (down):", statusData);
        const now = new Date();
        const messageText =
            `❌ ${process.env.DEPLOYNAME} — battery critical! Shutdown imminent!\n` +
            `Charge: ${this._fmtVal(statusData.charge, "%")} · Est. runtime: ${this._fmtVal(statusData.runtime, "s")}\n` +
            `[${formatDate(now)}]`;
        const internalId = await Director.broadcastMessage(messageText);
        await this.recordLog("down", statusData, internalId);
        this.lastInternalId = internalId;
        return internalId;
    }

    static async checkUps() {
        this.log("Starting UPS check...");
        try {
            const data = await this.getUpsStatus();
            const statusRaw = (data.status || "").toString().toLowerCase().trim();

            // Определяем состояние по 4 статусам
            let state;
            if (statusRaw.includes("loss") || statusRaw.includes("ob") || statusRaw.includes("dischrg")) state = "loss";
            else if (statusRaw.includes("online") || statusRaw.includes("ol")) state = "online";
            else if (statusRaw.includes("low")) state = "low";
            else if (statusRaw.includes("down")) state = "down";
            else state = "online"; // дефолт

            const statusData = {
                charge: this._parseNumberRaw(data["battery.charge"] ?? data["battery.charge.low"]),
                runtime: this._parseNumberRaw(data["battery.runtime"] ?? data["battery.runtime.low"]),
                inputVoltage: this._parseNumberRaw(data["input.voltage"]),
                outputVoltage: this._parseNumberRaw(data["output.voltage"]),
                loadPct: this._parseNumberRaw(data["ups.load"]),
                statusRaw,
            };

            this.log("UPS statusData:", statusData, "Computed state:", state);

            // Инициализация lastState
            if (this.lastState === null) {
                try {
                    const lastLog = await prisma.log.findFirst({ where: { type: "ups" }, orderBy: { time: "desc" } });
                    if (lastLog) this.lastState = lastLog.action;
                    else this.lastState = state;
                    this.log("Initialized lastState:", this.lastState, "lastInternalId:", this.lastInternalId);
                } catch (e) {
                    this.log("Failed to read last log:", e);
                    this.lastState = state;
                }
            }

            // Обработка переходов состояний
            if (state === "loss" && this.lastState !== "loss") await this.createBroadcastForOutage(statusData);
            else if (state === "online" && this.lastState === "loss") await this.createBroadcastForRestore(statusData);
            else if (state === "low" && this.lastState !== "low") await this.createBroadcastForLow(statusData);
            else if (state === "down" && this.lastState !== "down") await this.createBroadcastForDown(statusData);
            else this.log("No state change.");

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
                this.lastState = lastLog.action;
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
