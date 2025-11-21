const { configDotenv } = require("dotenv")
configDotenv({ quiet: true })
const { Telegraf, Markup } = require("telegraf")
const prisma = require("../prisma.js")
const bcrypt = require("bcrypt")
const actions = require("../actions.json")

const bot = new Telegraf(process.env.TGBOTKEY)

class Telegram {
    static async sendMessage(text, chatTgId) {
        // sendMessage(chatId, text, extras)
        return await bot.telegram.sendMessage(chatTgId, text, { parse_mode: "HTML" });
    }

    static async editMessage(newText, chatTgId, messageId) {
        // editMessageText(chatId, messageId, inline_message_id, text, extra)
        return await bot.telegram.editMessageText(chatTgId, messageId, undefined, newText, { parse_mode: "HTML" });
    }
}

bot.on("my_chat_member", async (ctx) => {
    try {
        const update = ctx.update.my_chat_member;
        if (!update) return;

        const chat = update.chat;
        if (chat.type !== "channel") return;

        const botId = ctx.botInfo?.id;
        const affectedUserId =
            update.new_chat_member?.user?.id ?? update.old_chat_member?.user?.id;
        if (!botId || affectedUserId !== botId) return;

        const newStatus = update.new_chat_member?.status;
        const oldStatus = update.old_chat_member?.status;

        const ACTIVE_STATUSES = ["creator", "administrator", "member"];
        const tgChatID = String(chat.id);

        if (ACTIVE_STATUSES.includes(newStatus) && !ACTIVE_STATUSES.includes(oldStatus)) {
            const existing = await prisma.tgChannel.findUnique({
                where: { tgChatID },
            });

            const name = chat.title || chat.username || null;
            const baseChatData = {
                name,
                settings: existing?.chatData?.settings ?? {
                    alerts: false, alertSettings: Object.fromEntries(
                        Object.keys(actions).map(key => [key, false])
                    )
                },
            };

            if (!existing) {
                await prisma.tgChannel.create({
                    data: {
                        tgChatID,
                        chatData: baseChatData,
                    },
                });
            } else {
                const mergedChatData = {
                    ...(existing.chatData ?? {}),
                    ...baseChatData,
                };

                await prisma.tgChannel.update({
                    where: { tgChatID },
                    data: {
                        chatData: mergedChatData,
                    },
                });
            }

            console.log(`Bot added to channel ${name ?? tgChatID}`);
            return;
        }

        if (newStatus === "kicked" && newStatus !== oldStatus) {
            await prisma.tgChannel.deleteMany({
                where: { tgChatID },
            });

            console.log(`Bot kicked from channel ${chat.title || tgChatID} — DB record removed`);
            return;
        }

    } catch (err) {
        console.error("Error handling my_chat_member:", err);
    }
});

bot.command("register", async (ctx) => {
    const username = ctx.args[0]

    if (!username) {
        ctx.reply("No username to register")
        return
    }

    const password = ctx.args[1]

    if (!password) {
        ctx.reply("No password for user")
        return
    }

    const user = await prisma.user.findFirst({ where: { username } })

    if (user) {
        ctx.reply(`User ${username} is already registered`)
        return
    }

    const newUser = await prisma.user.create({
        data: {
            username,
            password: await bcrypt.hash(password, await bcrypt.genSalt(parseInt(process.env.SALTROUNDS))),
            tgIds: {
                connectOrCreate: {
                    where: {
                        tgId: ctx.update.message.from.id
                    },
                    create: {
                        tgId: ctx.update.message.from.id
                    }
                }
            }
        }
    })

    if (!newUser) {
        ctx.reply("Error creating user")
        return
    }

    ctx.reply(`User ${username} registered successfully`)
    ctx.telegram.deleteMessage(ctx.update.message.chat.id, ctx.update.message.message_id)
})

bot.command("login", async (ctx) => {
    const username = ctx.args[0]

    if (!username) {
        ctx.reply("No username provided")
        return
    }

    const password = ctx.args[1]

    if (!password) {
        ctx.reply("No password provided")
        return
    }

    const user = await prisma.user.findFirst({ where: { username }, include: { tgIds: true } })

    if (!user) {
        ctx.reply(`User ${username} not found`)
        return
    }

    if (!await bcrypt.compare(password, user.password)) {
        ctx.reply("Wrong password")
        return
    }

    if (user.tgIds.some(v => v.tgId === ctx.update.message.from.id)) {
        ctx.reply("You are already logged in")
        ctx.telegram.deleteMessage(ctx.update.message.chat.id, ctx.update.message.message_id)
        return
    }

    await prisma.user.update({
        where: { id: user.id },
        data: {
            tgIds: {
                connectOrCreate: {
                    where: {
                        tgId: String(ctx.update.message.from.id)
                    },
                    create: {
                        tgId: String(ctx.update.message.from.id)
                    }
                }
            }
        }
    })
    ctx.reply(`Logged in as ${username}`)
    ctx.telegram.deleteMessage(ctx.update.message.chat.id, ctx.update.message.message_id)
})

bot.command("becomeadmin", async (ctx) => {
    const key = ctx.args[0]

    if (!key) {
        ctx.reply("No key provided")
        return
    }

    const user = await prisma.user.findFirst({
        where: {
            tgIds: {
                some: {
                    tgId: String(ctx.update.message.from.id)
                }
            }
        }
    })

    if (!user) {
        ctx.reply("You are not authorized")
        return
    }

    if (user.isAdmin) {
        ctx.reply("You are admin already")
        return
    }

    if (!process.env.adminKey === key) {
        ctx.reply("Key is incorrect")
        return
    }

    await prisma.user.update({
        where: {
            id: user.id
        },
        data: {
            isAdmin: true
        }
    })
    ctx.reply(`Congrats on becoming admin\nAll this shit is up to you now`)
    ctx.telegram.deleteMessage(ctx.update.message.chat.id, ctx.update.message.message_id)
})

bot.command("unadmin", async (ctx) => {
    const user = await prisma.user.findFirst({
        where: {
            tgIds: {
                some: {
                    tgId: String(ctx.update.message.from.id)
                }
            }
        }
    })

    if (!user) {
        ctx.reply("You are not authorized")
        return
    }

    if (!user.isAdmin) {
        ctx.reply("You are not an admin already")
        return
    }

    await prisma.user.update({
        where: {
            id: user.id
        },
        data: {
            isAdmin: false
        }
    })
    ctx.reply(`Congrats on stepping down from admin\nAll this shit is up to someone else now`)
})

bot.command("settings", async (ctx) => {
    const user = await prisma.user.findFirst({
        where: {
            tgIds: {
                some: {
                    tgId: String(ctx.update.message.from.id)
                }
            }
        }
    })

    if (!user) {
        ctx.reply("You are not authorized")
        return
    }

    ctx.reply("Available settings",
        Markup.inlineKeyboard([
            [Markup.button.callback(`${(await prisma.tgChannel.count())} Channels`, "sets:chn")]
        ])
    )
})

bot.action(/.*/, async (ctx) => {
    try {
        if (!ctx.callbackQuery || !ctx.callbackQuery.data) return;
        const action = String(ctx.callbackQuery.data).split(":");

        let text = "none";
        const inlineKeyboard = []; // array of rows, each row is an array of button objects

        switch (action[0]) {
            case "sets": {
                if (action[1] === "chn") {
                    // show a specific channel settings
                    if (action[2]) {
                        const chatId = action[2];
                        const chatData = await prisma.tgChannel.findFirst({
                            where: { tgChatID: chatId }
                        });
                        if (!chatData) {
                            text = `Chat with id ${chatId} not found`;
                            inlineKeyboard.push([{ text: "To main", callback_data: "main" }]);
                            break;
                        }

                        const settings = chatData.chatData?.settings?.alertSettings || {};
                        const alertsText = Object.entries(settings)
                            .map(([k, v]) => `${k}: ${v ? "✅" : "❌"}`)
                            .join("\n");

                        text = `Chat: ${chatData.chatData?.name || "Unnamed"}\n${alertsText}`;

                        // one button per row toggling the setting
                        for (const [key, value] of Object.entries(settings)) {
                            inlineKeyboard.push([
                                { text: `${key} ${value ? "✅" : "❌"}`, callback_data: `toggle:${chatId}:${key}` }
                            ]);
                        }

                        inlineKeyboard.push([{ text: "To main", callback_data: "main" }]);
                    } else {
                        // list channels
                        const channels = await prisma.tgChannel.findMany();
                        text = `${bot.botInfo?.first_name || "Bot"} is part of ${channels.length} channel${channels.length > 1 ? "s" : ""}`;

                        for (const channel of channels) {
                            inlineKeyboard.push([
                                { text: channel.chatData?.name || `#${channel.tgChatID}`, callback_data: `sets:chn:${String(channel.tgChatID)}` }
                            ]);
                        }

                        inlineKeyboard.push([{ text: "To main", callback_data: "main" }]);
                    }
                }
                break;
            }

            case "toggle": {
                // callback: toggle:<chatId>:<key>
                const chatId = action[1];
                const key = action[2];
                const chatData = await prisma.tgChannel.findFirst({ where: { tgChatID: chatId } });
                if (!chatData) {
                    text = `Chat ${chatId} not found`;
                    inlineKeyboard.push([{ text: "To main", callback_data: "main" }]);
                    break;
                }

                // guard: make sure the key exists
                const current = chatData.chatData?.settings?.alertSettings?.[key];
                if (typeof current === "undefined") {
                    text = `Setting "${key}" not found for chat ${chatData.chatData?.name || chatId}`;
                    inlineKeyboard.push([{ text: "To main", callback_data: "main" }]);
                    break;
                }

                // flip value and persist (adjust to how your Prisma schema expects JSON updates)
                chatData.chatData.settings.alertSettings[key] = !current;

                await prisma.tgChannel.update({
                    where: { tgChatID: chatId },
                    data: {
                        chatData: chatData.chatData // simplest: overwrite chatData JSON (use appropriate update if your schema requires)
                    }
                });

                // re-render
                const settings = chatData.chatData.settings.alertSettings;
                const alertsText = Object.entries(settings)
                    .map(([k, v]) => `${k}: ${v ? "✅" : "❌"}`)
                    .join("\n");
                text = `Chat: ${chatData.chatData.name}\n${alertsText}`;

                for (const [k, v] of Object.entries(settings)) {
                    inlineKeyboard.push([{ text: `${k} ${v ? "✅" : "❌"}`, callback_data: `toggle:${chatId}:${k}` }]);
                }

                inlineKeyboard.push([{ text: "To main", callback_data: "main" }]);
                break;
            }

            case "main":
            default: {
                const channelCount = await prisma.tgChannel.count();
                text = "Available settings";
                inlineKeyboard.push([{ text: `${channelCount} Channel${channelCount > 1 ? "s" : ""}`, callback_data: "sets:chn" }]);
                break;
            }
        }

        // Send to Telegram with explicit reply_markup
        await ctx.editMessageText(text, { reply_markup: { inline_keyboard: inlineKeyboard } });
        await ctx.answerCbQuery();
    } catch (e) {
        console.error("action handler error:", e);
    }
});


bot.telegram.setMyCommands([
    { command: "settings", description: "Settings to set up bot alerts and switch features" },
    { command: "register", description: "Register yourself in bot, usage: /register <username> <password>" },
    { command: "login", description: "Login in bot, usage: /login <username> <password>" },
    { command: "becomeadmin", description: "Become admin in bot, usage: /login <adminKey>" },
    { command: "unadmin", description: "Step down from being admin, usage: /unAdmin" },
])

bot.launch(() => {
    console.log("Tg bot started")
})

bot.telegram.getMe()

module.exports = Telegram
