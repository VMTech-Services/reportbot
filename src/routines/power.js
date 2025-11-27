// systemWatcher.js
const prisma = require("../prisma");
const Director = require("../director");
const formatDate = require("../scripts/formatDate")

class SystemWatcher {
    static async onStartup() {
        console.log("SystemWatcher: startup detected");

        const previousState = await prisma.log.findFirst({
            where: {
                type: "system",
                action: "shutdown",
            },
            orderBy: {
                time: "desc"
            }
        })

        let internalId

        if (previousState) {
            const result = await Director.editInternalMessage(previousState.internalMessageID, `🟢 Back up and running.\n[${formatDate(new Date().toISOString())}]\n\n🔴 ${process.env.DEPLOYNAME} shutting down.\n[${formatDate(previousState.time)}]`)
            internalId = result;
        } else {
            const result = await Director.broadcastMessage(`🟢 ${process.env.DEPLOYNAME} is up and running.\n[${formatDate(new Date().toISOString())}]`);
            internalId = result;
        }

        await prisma.log.create({
            data: {
                type: "system",
                action: "up",
                internalMessageID: internalId
            }
        });
    }

    static async onShutdown() {
        console.log("SystemWatcher: shutdown detected");

        const id = await Director.broadcastMessage(`🔴 ${process.env.DEPLOYNAME} shutting down.\n[${formatDate(new Date().toISOString())}]`);

        await prisma.log.create({
            data: {
                type: "system",
                action: "shutdown",
                internalMessageID: id
            }
        });
    }

    static setup() {
        this.onStartup().catch(console.error);

        const shutdownHandler = async () => {
            try {
                await this.onShutdown();
            } catch (err) {
                console.error(err);
            } finally {
                process.exit(0);
            }
        };

        process.on("SIGTERM", shutdownHandler);
        process.on("SIGINT", shutdownHandler);
    }
}

SystemWatcher.setup()