// dockerMonitor.js
const Docker = require("dockerode");
const prisma = require("../prisma");
const Director = require("../director");
const formatDate = require("../scripts/formatDate");
const fs = require("fs");

class DockerMonitor {
    static docker = null;
    static containers = {}; // key = containerId, value = { info, status }
    static internalId = null; // для редактирования единого сообщения
    static listening = false;

    static statusMap(state) {
        if (!state) return "stopped";
        if (state === "running") return "running";
        if (state === "restarting") return "restarting";
        if (state === "exited") return "stopped";
        if (state === "dead") return "removed";
        return state;
    }

    static async record(container, status) {
        return prisma.log.create({
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
        const all = Object.values(this.containers);

        const { groups, singles } = this.groupContainers(all.map(c => c.info));

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
        const text = this.formatMessage();
        if (this.internalId) {
            await Director.editInternalMessage(this.internalId, text);
        } else {
            this.internalId = await Director.broadcastMessage(text);
        }
    }

    static async scanContainers() {
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

        // проверяем удалённые контейнеры
        for (const id of Object.keys(this.containers)) {
            if (!list.find(c => c.Id === id)) {
                this.containers[id].status = "removed";
                changed = true;
                await this.record(this.containers[id].info, "removed");
            }
        }

        if (changed) {
            await this.updateMessage();
        }
    }

    static async handleEvent(evt) {
        const { Type, Actor } = evt;
        if (Type !== "container") return;

        const containerId = Actor?.ID;
        const cInfo = await this.docker.getContainer(containerId).inspect().catch(() => null);
        if (!cInfo) return;

        const status = this.statusMap(cInfo.State?.Status);
        this.containers[containerId] = { info: cInfo, status };

        await this.record(cInfo, status);
        await this.updateMessage();
    }

    static async checkDockerAvailable() {
        // проверяем сокет Docker
        const socketExists = fs.existsSync("/var/run/docker.sock");
        if (!socketExists) return false;

        // пробуем создать Docker объект и вызвать version
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
        await this.scanContainers(); // стартовое сообщение

        if (this.listening) return;
        this.listening = true;

        const stream = await this.docker.getEvents();
        stream.on("data", chunk => {
            const lines = chunk.toString("utf8").split("\n").filter(Boolean);
            for (const line of lines) {
                try {
                    const evt = JSON.parse(line);
                    this.handleEvent(evt);
                } catch (e) {
                    console.error("DockerMonitor: event parse error", e);
                }
            }
        });

        stream.on("error", err => {
            console.error("DockerMonitor: event stream error", err);
            setTimeout(() => this.start(), 5000);
        });

        stream.on("end", () => {
            console.warn("DockerMonitor: event stream ended");
            setTimeout(() => this.start(), 3000);
        });

        // периодический скан на случай пропущенных событий
        setInterval(() => this.scanContainers(), 10000);
    }
}

module.exports = DockerMonitor;

// автозапуск
DockerMonitor.start();
