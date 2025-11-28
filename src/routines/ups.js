const { exec } = require("child_process");
const prisma = require("../prisma");
const Director = require("../director");
const formatDate = require("../scripts/formatDate");

class UPSWatcher {
    static lastInternalId = null;
    static lastState = null;
    static lastCharge = null;
    static intervalHandle = null;

    // For estimating time-to-shutdown based on percent drop over time
    static chargeHistory = []; // { ts: ms, charge: number }
    static historyWindowMs = 10 * 60 * 1000; // keep last 10 minutes of samples
    static historyMax = 20; // also cap by count

    static log(...args) {
        console.log("[UPSWatcher]", ...args);
    }

    static getUpsName() {
        if (!process.env.NUTUPSNAME) throw new Error("UPS name not specified in NUTUPSNAME env");
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

    static async getLastLog() {
        const lastLog = await prisma.log.findFirst({
            where: { type: "ups" },
            orderBy: { time: "desc" }
        });
        if (lastLog) {
            this.lastInternalId = lastLog.internalMessageID;
            const data = lastLog.data || {};
            this.lastState = lastLog.action;
            this.lastCharge = data.charge ?? null;
        }
    }

    static async getUpsStatus() {
        const raw = await this.execUpsCommand(`upsc ${this.getUpsName()}`);
        const data = {};
        raw.split(/\r?\n/).forEach(line => {
            const [k, ...rest] = line.split(":");
            if (k) data[k.trim()] = rest.join(":").trim();
        });
        if (!Object.keys(data).length) throw new Error("Empty UPS status returned");
        return data;
    }

    static _fmt(v, suffix = "") {
        return (v === null || v === undefined || v === "") ? "N/A" : `${v}${suffix}`;
    }

    static _num(v) {
        if (v === undefined || v === null) return null;
        const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
        return Number.isFinite(n) ? n : null;
    }

    static async recordLog(action, data = {}) {
        const internalId = this.lastInternalId
            ? await Director.editInternalMessage(this.lastInternalId, data.messageText || "")
            : await Director.broadcastMessage(data.messageText || "");

        if (!this.lastInternalId) {
            await prisma.log.create({ data: { type: "ups", action, data, internalMessageID: internalId } });
        } else {
            await prisma.log.updateMany({
                where: { internalMessageID: this.lastInternalId },
                data: { action, data }
            });
        }

        this.lastInternalId = internalId;
        return internalId;
    }

    static estimateTimeToShutdown(currentCharge, criticalPercent = 10) {
        if (currentCharge === null || currentCharge === undefined) return null;

        const now = Date.now();
        this.chargeHistory = this.chargeHistory.filter(e => (now - e.ts) <= this.historyWindowMs);
        if (this.chargeHistory.length < 2) return null;

        const oldest = this.chargeHistory[0];
        const newest = this.chargeHistory[this.chargeHistory.length - 1];

        const deltaPercent = newest.charge - oldest.charge;
        const deltaSeconds = (newest.ts - oldest.ts) / 1000;
        if (deltaSeconds <= 0) return null;

        const ratePctPerSec = -deltaPercent / deltaSeconds;
        if (!(ratePctPerSec > 0)) return null;

        const safeThreshold = criticalPercent;
        const secondsLeft = (currentCharge - safeThreshold) / ratePctPerSec;
        if (secondsLeft < 0) return 0;
        return Math.round(secondsLeft);
    }

    static formatSeconds(seconds) {
        if (seconds === null || seconds === undefined) return "N/A";
        if (!Number.isFinite(seconds)) return "N/A";
        const sec = Math.max(0, Math.floor(seconds));
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        if (h > 0) return `${h}h ${m}m ${s}s`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }

    static buildMessage(status, statusData) {
        const iconMap = { loss: "🔴", online: "🟢", low: "⚠️", down: "❌" };
        const textMap = {
            loss: "power outage detected!",
            online: "power restored",
            low: "battery low",
            down: "battery critical! Shutdown imminent"
        };

        const etaText = (statusData.etaSeconds !== undefined && statusData.etaSeconds !== null)
            ? ` · Est. to shutdown: ${this.formatSeconds(statusData.etaSeconds)}`
            : "";

        return `${iconMap[status]} ${process.env.DEPLOYNAME} - ${textMap[status]}\n` +
            `${etaText}\n` +
            `[${formatDate(new Date())}]`;
    }

    static async checkUps() {
        try {
            const data = await this.getUpsStatus();
            const statusRaw = (data["ups.status"] || "").toLowerCase();
            const charge = this._num(data["battery.charge"] ?? data["battery.charge.low"]);
            const runtime = this._num(data["battery.runtime"] ?? data["battery.runtime.low"]);
            const inputVoltage = this._num(data["input.voltage"]);
            const outputVoltage = this._num(data["output.voltage"]);
            const loadPct = this._num(data["ups.load"]);

            const statusData = { charge, runtime, inputVoltage, outputVoltage, loadPct };

            // Update charge history for ETA calculation
            if (charge !== null) {
                const now = Date.now();
                // push only if history empty or charge changed meaningfully
                const last = this.chargeHistory.length ? this.chargeHistory[this.chargeHistory.length - 1] : null;
                if (!last || Math.abs(last.charge - charge) >= 0.1) {
                    this.chargeHistory.push({ ts: now, charge });
                }
                // cap length
                if (this.chargeHistory.length > this.historyMax) this.chargeHistory.shift();
            }

            // compute ETA based on percent drop; threshold uses battery.charge.low if available
            const criticalPercent = this._num(data["battery.charge.low"]) ?? 10;
            const etaSeconds = this.estimateTimeToShutdown(charge, criticalPercent);
            if (etaSeconds !== null) statusData.etaSeconds = etaSeconds;

            let state;
            if (statusRaw.includes("ob") || statusRaw.includes("dischrg")) state = "loss";
            else if (statusRaw.includes("ol")) state = "online";
            else if (charge !== null && charge <= (data["battery.charge.low"] ?? 10)) state = "low";
            else if (statusRaw.includes("down") || (runtime !== null && runtime <= 0)) state = "down";
            else state = "online";

            if (state === "loss") {
                statusData.messageText = this.buildMessage("loss", statusData);
                await this.recordLog("loss", statusData);

                if (this.lastState !== "loss" || this.lastCharge !== charge) {
                    this.log(`UPS state: ${state}, charge: ${charge}%`, statusData.etaSeconds ? `eta ${this.formatSeconds(statusData.etaSeconds)}` : "");
                }

                this.lastState = "loss";
                this.lastCharge = charge;

            } else if (state === "online") {
                if (this.lastState === "loss") {
                    statusData.messageText = this.buildMessage("online", statusData);
                    await this.recordLog("online", statusData);
                    this.lastState = "online";
                    this.lastCharge = charge;
                }

                if (this.lastState === "online" && charge < 100) {
                    statusData.messageText = this.buildMessage("online", statusData);
                    await this.recordLog("online", statusData);
                    this.lastCharge = charge;
                }

                if (charge >= 100) {
                    this.lastInternalId = null;
                    this.lastState = null;
                    this.lastCharge = null;
                    this.chargeHistory = [];
                }
            }

        } catch (err) {
            this.log("checkUps error:", err);
        }
    }

    static async setup(intervalMs = 5000) {
        await this.getLastLog();
        try { await this.getUpsStatus(); }
        catch (err) { this.log("Cannot probe UPS:", err); return false; }
        await this.checkUps();
        this.intervalHandle = setInterval(() => this.checkUps(), intervalMs);
        return true;
    }
}

UPSWatcher.setup();
module.exports = UPSWatcher;
