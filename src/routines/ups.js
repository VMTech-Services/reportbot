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
            exec(cmd, (err, stdout, stderr) => {
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
            const [key, value] = line.split(":").map(s => s.trim());
            if (key) data[key] = value;
        }
        return data;
    }

    static async checkUps() {
        try {
            const data = await this.getUpsStatus();
            const state = data.status === "OB" ? "onbattery" : "online";
            const charge = parseFloat(data["battery.charge"] || data["battery.charge.low"] || 0);
            const minCharge = parseFloat(data["battery.runtime.low"] || data["battery.runtime"] || 0);
            const now = new Date();

            let messageText;
            if (state === "onbattery") {
                messageText = `🔴 ${process.env.DEPLOYNAME} power outage detected!\nCharge: ${charge}% / min ${minCharge}%\n[${formatDate(now.toISOString())}]`;
            } else {
                messageText = `🟢 ${process.env.DEPLOYNAME} power restored\nCharge: ${charge}%\n[${formatDate(now.toISOString())}]`;
            }

            if (this.lastInternalId) {
                await Director.editInternalMessage(this.lastInternalId, messageText);
            } else {
                const internalId = await Director.broadcastMessage(messageText);
                this.lastInternalId = internalId;
            }

            await prisma.log.create({
                data: {
                    type: "ups",
                    action: state,
                    data: { charge, minCharge },
                    internalMessageID: this.lastInternalId
                }
            });

            this.lastState = state;
        } catch (err) {
            console.error("UPSWatcher error:", err);
        }
    }

    static setup(intervalMs = 5000) {
        console.log("UPSWatcher: monitoring started");
        this.checkUps();
        setInterval(() => this.checkUps(), intervalMs);
    }
}

UPSWatcher.setup()
