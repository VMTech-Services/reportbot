// dockerMonitorRealtime.js
const Docker = require("dockerode");
const prisma = require("../prisma");
const Director = require("../director");
const formatDate = require("../scripts/formatDate");
const fs = require("fs");

class DockerMonitorRealtime {
    static docker = null;
    static containers = {}; // containerId -> { info, status }
    static lastShown = {}; // what statuses were last shown (containerId -> status) — используется для diff
    static internalId = null; // текущее сообщение показывающее проблемные контейнеры
    static listening = false;
    static scanIntervalHandle = null;

    static statusMap(state) {
        if (!state) return "stopped";
        if (state === "running") return "running";
        if (state === "restarting") return "restarting";
        if (state === "exited") return "stopped";
        if (state === "dead") return "removed";
        if (state === "unhealthy") return "unhealthy";
        return state;
    }

    static getDisplayName(info) {
        // Если есть имя контейнера - берем первое
        const name = info?.Names?.[0];
        if (name) return name.replace(/^\//, "");
        // иначе берем из образа: последнее часть пути без тега
        const image = info?.Config?.Image || info?.Image || "";
        const last = image.split("/").pop() || image;
        return last.split(":")[0] || (info?.Id || "").slice(0, 12);
    }

    static async record(container, status) {
        try {
            await prisma.log.create({
                data: {
                    type: "docker",
                    action: status,
                    data: {
                        id: container.Id,
                        name: this.getDisplayName(container),
                        image: container.Image,
                        labels: container.Labels,
                    },
                },
            });
        } catch (e) {
            console.error("DockerMonitor: failed to write log:", e);
        }
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

    // строит компактное сообщение только по списку контейнеров (обычно по проблемным или по изменённым)
    static buildCompactMessage(changedList, totalProblematicCount) {
        // changedList: [{ id, info, status, prevStatus }]
        const when = formatDate(new Date());
        let header = `🐳 Docker changes — ${when}\n`;
        header += `🔔 Problematic containers: ${totalProblematicCount}\n\n`;

        // сгруппируем changedList по проектам, чтобы показывать compose вместе
        const grouped = {};
        for (const item of changedList) {
            const project = item.info?.Labels?.["com.docker.compose.project"] || null;
            const key = project || "__standalone__";
            if (!grouped[key]) grouped[key] = [];
            grouped[key].push(item);
        }

        let body = "";
        for (const [project, items] of Object.entries(grouped)) {
            if (project === "__standalone__") {
                body += `📦 Standalone\n`;
            } else {
                body += `📦 Compose: ${project}\n`;
            }
            for (const it of items) {
                const displayName = this.getDisplayName(it.info);
                const image = it.info?.Config?.Image || it.info?.Image || "";
                const prev = it.prevStatus ? `(${it.prevStatus} → ${it.status})` : `(${it.status})`;
                body += `  • ${displayName} ${prev} — ${image}\n`;
            }
            body += `\n`;
        }

        return header + body.trim();
    }

    // возвращает список всех проблемных контейнеров (не running/healthy)
    static getProblematicList() {
        return Object.entries(this.containers)
            .map(([id, v]) => ({ id, info: v.info, status: v.status }))
            .filter(x => !(x.status === "running" || x.status === "healthy"));
    }

    // отправляет/редактирует сообщение с изменениями — но только если есть изменения
    static async showChanges(changedItems) {
        // changedItems: [{ id, info, status, prevStatus }]
        if (!changedItems || changedItems.length === 0) return;

        const problematic = this.getProblematicList();
        const totalProblematic = problematic.length;

        // Если после изменений проблем нет — удаляем внутреннюю привязку (забываем сообщение)
        if (totalProblematic === 0) {
            if (this.internalId) {
                // можно отредактировать сообщение в режиме "all good" или просто забыть
                try {
                    // стараемся отредактировать, чтобы оставить след в чате, но можно и просто забыть
                    await Director.editInternalMessage(this.internalId, `✅ All containers are running and healthy\n[${formatDate(new Date())}]`);
                } catch (e) {
                    // если редактирование упало — игнорируем
                }
                // забываем message (в дальнейшем будем создавать новое при следующей проблеме)
                this.internalId = null;
            }
            // обновляем lastShown: теперь ничего проблемного не показывали
            this.lastShown = {};
            return;
        }

        // строим компактный текст только для changedItems, но показываем общее количество проблемных
        const text = this.buildCompactMessage(changedItems, totalProblematic);

        if (this.internalId) {
            // редактируем текущее сообщение
            try {
                await Director.editInternalMessage(this.internalId, text);
            } catch (e) {
                // если редактирование упало — пробуем пересоздать
                try {
                    this.internalId = await Director.broadcastMessage(text);
                } catch (err) {
                    console.error("DockerMonitor: failed to broadcast after edit failed", err);
                }
            }
        } else {
            // создаём новое сообщение (показываем конкретные изменения)
            try {
                this.internalId = await Director.broadcastMessage(text);
            } catch (e) {
                console.error("DockerMonitor: broadcast failed", e);
            }
        }

        // Обновляем lastShown для тех контейнеров, которые мы показали
        for (const it of changedItems) {
            this.lastShown[it.id] = it.status;
        }
    }

    // обрабатывает изменения для одного контейнера (id, newInfo, newStatus)
    static async processStatusChange(id, info, newStatus) {
        const prev = this.containers[id]?.status;
        // если статус не изменился — ничего не делаем
        if (prev === newStatus) return;

        // обновляем память
        this.containers[id] = { info, status: newStatus };

        // логируем в БД
        await this.record(info, newStatus);

        // готовим объект изменения
        const changed = [{ id, info, status: newStatus, prevStatus: prev || null }];

        // Если lastShown не содержит этот id или значение отличается — показываем
        // (это исключает повторную отправку одного и того же статуса)
        const lastShownStatus = this.lastShown[id];
        if (lastShownStatus === newStatus) {
            // уже показывали этот статус ранее — ничего не делать
            return;
        }

        // Показываем изменения
        await this.showChanges(changed);
    }

    // initial scan: не шлём полный дамп, только если есть проблемные контейнеры — отправляем compact о них
    static async initialScanAndMaybeShow() {
        try {
            const list = await this.docker.listContainers({ all: true });
            for (const c of list) {
                const status = this.statusMap(c.State);
                this.containers[c.Id] = { info: c, status };
                // заполняем lastShown таким образом, чтобы избежать повторной отправки статусов сразу
                this.lastShown[c.Id] = status;
            }

            // если есть проблемные — создаём одно сообщение с ними и пометим их в lastShown
            const problematic = Object.entries(this.containers)
                .map(([id, v]) => ({ id, info: v.info, status: v.status }))
                .filter(x => !(x.status === "running" || x.status === "healthy"));

            if (problematic.length) {
                // показываем все проблемные как одно компактное сообщение
                const changedItems = problematic.map(p => ({ id: p.id, info: p.info, status: p.status, prevStatus: null }));
                const text = this.buildCompactMessage(changedItems, problematic.length);
                try {
                    this.internalId = await Director.broadcastMessage(text);
                } catch (e) {
                    console.error("DockerMonitor: broadcast failed on init", e);
                }
                // lastShown уже установлен равным текущему статусу, но для ясности - обновим
                for (const p of problematic) this.lastShown[p.id] = p.status;
            } else {
                // все хорошо — ничего не показываем и очищаем internalId
                this.internalId = null;
            }
        } catch (e) {
            console.error("DockerMonitor initial scan error:", e);
        }
    }

    // --- Реальное время: обработка событий Docker ---
    static async handleEvent(evt) {
        if (evt.Type !== "container") return;

        const containerId = evt.Actor?.ID;
        if (!containerId) return;

        // иногда события бывают "destroy" и контейнера нету — пробуем получить инфо
        const container = this.docker.getContainer(containerId);
        const info = await container.inspect().catch(() => null);

        let status;
        if (!info) {
            // контейнер удалён — пометим как removed
            status = "removed";
            // если раньше у нас был info — используем его для логов, иначе создаём минимальный объект
            const prevInfo = this.containers[containerId]?.info || { Id: containerId, Names: [], Image: evt?.Actor?.Attributes?.image || "" };
            this.containers[containerId] = { info: prevInfo, status };
            await this.record(prevInfo, status);
            // обработаем изменение
            await this.processStatusChange(containerId, prevInfo, status);
            return;
        }

        status = this.statusMap(info.State?.Status);

        // обработаем только если статус изменился по отношению к текущему known state
        const prevKnown = this.containers[containerId]?.status;
        if (prevKnown === status) {
            // но всё равно обновим info (чтобы имена/лейблы были свежие)
            this.containers[containerId] = { info, status };
            return;
        }

        // process change (лог + сообщение)
        await this.processStatusChange(containerId, info, status);
    }

    static async listenDockerEvents() {
        try {
            const stream = await this.docker.getEvents();
            stream.on("data", chunk => {
                const lines = chunk.toString("utf8").split("\n").filter(Boolean);
                for (const line of lines) {
                    try {
                        const evt = JSON.parse(line);
                        // не блокируем цикл — handleEvent асинхронно
                        this.handleEvent(evt).catch(err => console.error("DockerMonitor handleEvent error:", err));
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

        // инициализация: делаем initial scan, но не шлём полный дамп — только проблемные
        await this.initialScanAndMaybeShow();

        // start events listening
        if (!this.listening) {
            this.listening = true;
            this.listenDockerEvents();
        }

        // резервное сканирование (короткие diffs) — если что-то пропущено
        if (!this.scanIntervalHandle) {
            this.scanIntervalHandle = setInterval(() => {
                // скан будет собирать отличия и вызывать processStatusChange только когда статус изменится
                this.scanContainers().catch(err => console.error("DockerMonitor scan error:", err));
            }, 10000);
        }
    }

    static async scanContainers() {
        try {
            const list = await this.docker.listContainers({ all: true });

            // отмечаем найденные контейнеры и обновляем статусы (вызываем processStatusChange при отличии)
            const seen = new Set();
            for (const c of list) {
                const status = this.statusMap(c.State);
                seen.add(c.Id);

                const prev = this.containers[c.Id]?.status;
                // update info object & call processStatusChange if differs
                this.containers[c.Id] = { info: c, status };

                if (prev !== status) {
                    // важно: используем processStatusChange, он уже логирует и вызывает showChanges
                    await this.processStatusChange(c.Id, c, status);
                }
            }

            // обнаруживаем удалённые контейнеры
            for (const id of Object.keys(this.containers)) {
                if (!seen.has(id) && this.containers[id].status !== "removed") {
                    const prevInfo = this.containers[id].info;
                    this.containers[id].status = "removed";
                    await this.record(prevInfo, "removed");
                    await this.processStatusChange(id, prevInfo, "removed");
                }
            }
        } catch (e) {
            console.error("DockerMonitor scan error:", e);
        }
    }
}

module.exports = DockerMonitorRealtime;

// автозапуск
DockerMonitorRealtime.start();
