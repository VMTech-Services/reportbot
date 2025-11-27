// dockerMonitorRealtime.js
const Docker = require("dockerode");
const prisma = require("../prisma");
const Director = require("../director");
const formatDate = require("../scripts/formatDate");
const fs = require("fs");

class DockerMonitorRealtime {
    static docker = null;
    static containers = {};
    static internalId = null;
    static listening = false;

    static statusMap(state) {
        if (!state) return "stopped";
        if (state === "running") return "running";
        if (state === "restarting") return "restarting";
        if (state === "exited") return "stopped";
        if (state === "dead") return "removed";
        if (state === "unhealthy") return "unhealthy";
        return state;
    }

    static async record(container, status) {
        await prisma.log.create({
            data: {
                type: "docker",
                action: status,
                data: {
                    id: container.Id,
                    name: container.Names?.[0]?.replace(/^\//, "") || container.Id.slice(0, 12),
                    image: container.Image,
                    labels: container.Labels,
                },
            },
        });
    }

    static groupContainers(containers) {
        const groups = {};
        const singles = [];

        for (const c of containers) {
            const project = c.Labels?.["com.docker.compose.project"];
            if (project) {
                if (!groups[project]) groups[project] = [];
                groups[project].push(c);
            } else {
                singles.push(c);
            }
        }

        return { groups, singles };
    }

    static formatMessage() {
        const all = Object.values(this.containers).map(c => c.info);

        const { groups, singles } = this.groupContainers(all);

        let msg = `🐳 Docker containers status\n[${formatDate(new Date())}]\n\n`;

        for (const [project, list] of Object.entries(groups)) {
            msg += `📦 Compose: ${project}\n`;
            for (const c of list.sort((a, b) => a.Image.localeCompare(b.Image))) {
                const status = this.containers[c.Id].status;
                msg += `  ${c.Names?.[0]?.replace(/^\//, "") || c.Id.slice(0, 12)}: ${status}\n`;
            }
            msg += "\n";
        }

        if (singles.length) {
            msg += `📦 Standalone\n`;
            for (const c of singles.sort((a, b) => a.Image.localeCompare(b.Image))) {
                const status = this.containers[c.Id].status;
                msg += `  ${c.Names?.[0]?.replace(/^\//, "") || c.Id.slice(0, 12)}: ${status}\n`;
            }
        }

        return msg;
    }

    static async updateMessage() {
        if (Object.values(this.containers).length === 0) return;

        const allRunningHealthy = Object.values(this.containers).every(c =>
            c.status === "running" || c.status === "healthy"
        );

        if (allRunningHealthy && this.internalId) {
            console.log("DockerMonitor: all containers running, clearing message");
            this.internalId = null;
        }

        if (!allRunningHealthy || !this.internalId) {
            const text = this.formatMessage();
            if (this.internalId) {
                await Director.editInternalMessage(this.internalId, text);
            } else {
                this.internalId = await Director.broadcastMessage(text);
            }
        }
    }

    static async scanContainers() {
        try {
            const list = await this.docker.listContainers({ all: true });
            let changed = false;

            for (const c of list) {
                const status = this.statusMap(c.State);
                if (!this.containers[c.Id]) {
                    this.containers[c.Id] = { info: c, status };
                    changed = true;
                    await this.record(c, status);
                } else if (this.containers[c.Id].status !== status) {
                    this.containers[c.Id].status = status;
                    changed = true;
                    await this.record(c, status);
                }
            }

            for (const id of Object.keys(this.containers)) {
                if (!list.find(c => c.Id === id)) {
                    this.containers[id].status = "removed";
                    changed = true;
                    await this.record(this.containers[id].info, "removed");
                }
            }

            if (changed) await this.updateMessage();
        } catch (e) {
            console.error("DockerMonitor scan error:", e);
        }
    }

    static async handleEvent(evt) {
        if (evt.Type !== "container") return;

        const containerId = evt.Actor?.ID;
        if (!containerId) return;

        const container = this.docker.getContainer(containerId);
        const info = await container.inspect().catch(() => null);
        if (!info) return;

        const status = this.statusMap(info.State?.Status);
        this.containers[containerId] = { info, status };

        await this.record(info, status);
        await this.updateMessage();
    }

    static async listenDockerEvents() {
        try {
            const stream = await this.docker.getEvents();
            stream.on("data", chunk => {
                const lines = chunk.toString("utf8").split("\n").filter(Boolean);
                for (const line of lines) {
                    try {
                        const evt = JSON.parse(line);
                        this.handleEvent(evt);
                    } catch (e) {
                        console.error("DockerMonitor: failed to parse event", e);
                    }
                }
            });

            stream.on("error", err => {
                console.error("DockerMonitor: event stream error", err);
                setTimeout(() => this.listenDockerEvents(), 5000);
            });

            stream.on("end", () => {
                console.warn("DockerMonitor: event stream ended");
                setTimeout(() => this.listenDockerEvents(), 3000);
            });
        } catch (err) {
            console.error("DockerMonitor: cannot connect to Docker events:", err);
            setTimeout(() => this.listenDockerEvents(), 5000);
        }
    }

    static async checkDockerAvailable() {
        if (!fs.existsSync("/var/run/docker.sock")) return false;

        try {
            const docker = new Docker({ socketPath: "/var/run/docker.sock" });
            await docker.version();
            this.docker = docker;
            return true;
        } catch (err) {
            console.error("DockerMonitor: Docker not available", err.message);
            return false;
        }
    }

    static async start() {
        const available = await this.checkDockerAvailable();
        if (!available) {
            console.warn("DockerMonitor: Docker not found, monitor disabled");
            return;
        }

        console.log("DockerMonitor: starting...");

        await this.scanContainers();

        if (!this.listening) {
            this.listening = true;
            this.listenDockerEvents();
        }

        setInterval(() => this.scanContainers(), 10000);
    }
}

module.exports = DockerMonitorRealtime;

DockerMonitorRealtime.start();
