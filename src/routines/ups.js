const { exec } = require("child_process");
const prisma = require("../prisma");
const Director = require("../director");
const formatDate = require("../scripts/formatDate");

class UPSWatcher {
    static lastInternalId = null;
    static lastState = null;
    static lastCharge = null;
    static intervalHandle = null;

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
            orderBy: { createdAt: "desc" }
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
            ? await Director.updateMessage(this.lastInternalId, data.messageText || "")
            : await Director.broadcastMessage(data.messageText || "");

        if (!this.lastInternalId) {
            await prisma.log.create({ data: { type: "ups", action, data, internalMessageID: internalId } });
        } else {
            await prisma.log.update({
                where: { internalMessageID: this.lastInternalId },
                data: { action, data }
            });
        }

        this.lastInternalId = internalId;
        return internalId;
    }

    static buildMessage(status, statusData) {
        const iconMap = { loss: "🔴", online: "🟢", low: "⚠️", down: "❌" };
        const textMap = {
            loss: "power outage detected!",
            online: "power restored",
            low: "battery low",
            down: "battery critical! Shutdown imminent"
        };
        return `${iconMap[status]} ${process.env.DEPLOYNAME} — ${textMap[status]}\n` +
            `Charge: ${this._fmt(statusData.charge, "%")} · Runtime: ${this._fmt(statusData.runtime, "s")}\n` +
            `Vin: ${this._fmt(statusData.inputVoltage, "V")} · Vout: ${this._fmt(statusData.outputVoltage, "V")} · Load: ${this._fmt(statusData.loadPct, "%")}\n` +
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

            let state;
            if (statusRaw.includes("ob") || statusRaw.includes("dischrg")) state = "loss";
            else if (statusRaw.includes("ol")) state = "online";
            else if (charge !== null && charge <= (data["battery.charge.low"] ?? 10)) state = "low";
            else if (statusRaw.includes("down") || (runtime !== null && runtime <= 0)) state = "down";
            else state = "online";

            if (state === "loss") {
                if (this.lastState === "loss" || (this.lastState === "online" && this.lastCharge < 100)) {
                    statusData.messageText = this.buildMessage("loss", statusData);
                    await this.recordLog("loss", statusData);
                } else {
                    this.lastCharge = charge;
                    statusData.messageText = this.buildMessage("loss", statusData);
                    await this.recordLog("loss", statusData);
                }
                this.lastState = "loss";
            } else if (state === "online") {
                statusData.messageText = this.buildMessage("online", statusData);
                await this.recordLog("online", statusData);

                if (charge >= 100) {
                    this.lastInternalId = null;
                    this.lastState = null;
                    this.lastCharge = null;
                } else {
                    this.lastCharge = charge;
                    this.lastState = "online";
                }
            }

            if (this.lastCharge !== charge) {
                this.log(`UPS state: ${state}, charge: ${charge}%`);
            }

            this.lastCharge = charge;

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
