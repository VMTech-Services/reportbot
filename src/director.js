const Telegram = require("./botControllers/tg");
const prisma = require("./prisma");

class Director {
    static async broadcastMessage(text) {
        const tgChats = await prisma.tgChannel.findMany();

        const internal = await prisma.internalMessage.create({
            data: {
                content: { text }
            }
        });

        const createdMessages = [];

        for (const chat of tgChats) {
            try {
                const tgRes = await Telegram.sendMessage(text, chat.tgChatID);

                const dbMsg = await prisma.tgMessage.create({
                    data: {
                        chatID: chat.id,
                        internalMsgID: internal.id,
                        tgData: {
                            chatID: chat.tgChatID,
                            msgID: tgRes.message_id
                        }
                    }
                });

                createdMessages.push(dbMsg);
            } catch (err) {
                console.error(`Failed to send/save message for chat ${chat.tgChatID}:`, err);
            }
        }

        return internal.id;
    }

    static async editInternalMessage(internalId, newText) {
        const internal = await prisma.internalMessage.findUnique({
            where: { id: internalId },
            include: { tgMessages: true }
        });

        if (!internal) throw new Error("Internal message not found");

        for (const tgMsg of internal.tgMessages) {
            try {
                const chatTgId = tgMsg.tgData?.chatID;
                const msgId = tgMsg.tgData?.msgID;
                if (chatTgId && msgId) {
                    await Telegram.editMessage(newText, String(chatTgId), Number(msgId));
                } else {
                    console.warn("tgMessage missing tgData:", tgMsg.id);
                }
            } catch (err) {
                console.error(`Failed to edit message ${tgMsg.id} in chat ${tgMsg.tgData?.chatID}:`, err);
            }
        }

        return internalId
    }
}

module.exports = Director