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
                if (err) return reject(err);
                if (stderr) this.log("Command stderr:", stderr.trim());
                resolve(stdout ? stdout.trim() : "");
            });
        });
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
        const internalId = await Director.broadcastMessage(data.messageText || "");
        await prisma.log.create({ data: { type: "ups", action, data, internalMessageID: internalId } });
        this.lastInternalId = internalId;
        return internalId;
    }

    static async broadcast(status, statusData) {
        const now = new Date();
        let icon, text;
        switch (status) {
            case "loss":
                icon = "🔴"; text = "power outage detected!"; break;
            case "online":
                icon = "🟢"; text = "power restored"; break;
            case "low":
                icon = "⚠️"; text = "battery low"; break;
            case "down":
                icon = "❌"; text = "battery critical! Shutdown imminent"; break;
        }
        const messageText = `${icon} ${process.env.DEPLOYNAME} — ${text}\n` +
            `Charge: ${this._fmt(statusData.charge, "%")} · Runtime: ${this._fmt(statusData.runtime, "s")}\n` +
            `Vin: ${this._fmt(statusData.inputVoltage, "V")} · Vout: ${this._fmt(statusData.outputVoltage, "V")} · Load: ${this._fmt(statusData.loadPct, "%")}\n` +
            `[${formatDate(now)}]`;
        statusData.messageText = messageText;
        await this.recordLog(status, statusData);
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

            // Определяем состояние
            let state;
            if (statusRaw.includes("ob") || statusRaw.includes("dischrg")) state = "loss";
            else if (statusRaw.includes("ol")) state = "online";
            else if (charge !== null && charge <= (data["battery.charge.low"] ?? 10)) state = "low";
            else if (statusRaw.includes("down") || (runtime !== null && runtime <= 0)) state = "down";
            else state = "online";

            this.log("UPS statusData:", statusData, "Computed state:", state);

            if (this.lastState !== state) {
                this.log(`State changed: ${this.lastState} -> ${state}`);
                await this.broadcast(state, statusData);
            } else {
                this.log("No state change.");
            }

            this.lastState = state;
        } catch (err) {
            this.log("checkUps error:", err);
        }
    }

    static async setup(intervalMs = 5000) {
        try { await this.getUpsStatus(); }
        catch (err) { this.log("Cannot probe UPS:", err); return false; }
        await this.checkUps();
        this.intervalHandle = setInterval(() => this.checkUps(), intervalMs);
        this.log("UPSWatcher monitoring started, interval:", intervalMs);
        return true;
    }
}

UPSWatcher.setup();
module.exports = UPSWatcher;
