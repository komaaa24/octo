import {Bot, Context, InlineKeyboard, SessionFlavor} from 'grammy';
import {IUserDocument, UserModel} from '../database/models/user.model';
import {config, SubscriptionType} from '../config';
import logger from '../utils/logger';
import {ClickSubsApiService} from "../payment-providers/click-subs-api/click-subs-api.service";
import {PaymentCardTokenDto} from "../payment-providers/click-subs-api/dto/request/payment-card-token.dto";

interface SessionData {
    pendingSubscription?: {
        type: SubscriptionType
    };
    hasAgreedToTerms?: boolean;
}

type BotContext = Context & SessionFlavor<SessionData>;

export class SubscriptionMonitorService {
    private bot: Bot<BotContext>;

    constructor(bot: Bot<BotContext>) {
        this.bot = bot;
    }

    async checkExpiringSubscriptions(): Promise<void> {
        const threeDaysFromNow = new Date();
        threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);

        // Get the start of today (midnight)
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const expiringUsers = await UserModel.find({
            subscriptionEnd: {
                $gte: new Date(),
                $lte: threeDaysFromNow
            },
            isActive: true,
            subscriptionType: 'onetime',
            $or: [
                { lastWarningDate: { $exists: false } },
                { lastWarningDate: { $lt: today } }
            ]
        });

        for (const user of expiringUsers) {
            await this.sendExpirationWarning(user);
        }
    }

    async handleExpiredSubscriptions(): Promise<void> {
        const now = new Date();

        const expiredUsers = await UserModel.find({
            subscriptionEnd: {$lt: now},
            isActive: true,
            isKickedOut: false,
            subscriptionType: 'onetime'
        });

        for (const user of expiredUsers) {
            await this.handleExpiredUser(user);
        }
    }

    private async sendExpirationWarning(user: IUserDocument): Promise<void> {
        try {
            const daysLeft = Math.ceil(
                (user.subscriptionEnd.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)
            );

            const keyboard = new InlineKeyboard()
                .text("🔄 Obunani yangilash", "renew")
                .row()
                .text("📊 Obuna holati", "check_status");

            if (!user.hasSentWarning) {
                const message = `⚠️ Ogohlantirish!\n\n` +
                    `Sizning obunangiz ${daysLeft} kundan so'ng tugaydi.\n` +
                    `Agar obunani yangilamasangiz, kanal a'zoligidan chiqarilasiz.\n\n` +
                    `Obunani yangilash uchun quyidagi tugmani bosing:`;
                await this.bot.api.sendMessage(
                    user.telegramId,
                    message,
                    {reply_markup: keyboard}
                );

                logger.info(`Sent expiration warning to user ${user.telegramId}`);

                user.lastWarningDate = new Date();
                await user.save();
                logger.info(`Updated lastWarningDate for user ${user.telegramId}`);
            }

        } catch (error) {
            logger.error(`Error sending expiration warning to user ${user.telegramId}:`, error);
        }
    }

    public async handleExpiredUser(user: IUserDocument): Promise<void> {
        try {
            const channelId = user.subscribedTo === 'wrestling'
                ? config.WRESTLING_CHANNEL_ID
                : config.CHANNEL_ID;

            // Kick user from channel when one-time access expires.
            try {
                const kickUntil = Math.floor(Date.now() / 1000) + 30;
                await this.bot.api.banChatMember(channelId, user.telegramId, {
                    until_date: kickUntil
                });
                await this.bot.api.unbanChatMember(channelId, user.telegramId);
            } catch (kickError) {
                logger.error(`Failed to remove expired user ${user.telegramId} from channel ${channelId}:`, kickError);
            }

            // Update user status
            user.hasSentWarning = true;
            user.isActive = false;
            user.isActiveForFootball = false;
            user.isActiveSubsForWrestling = false;
            user.isKickedOut = true;
            await user.save();

            const keyboard = new InlineKeyboard()
                .text("🎯 Qayta obuna bo'lish", "subscribe")
                .row()
                .text("📊 Obuna holati", "check_status");

            const message = `❌ Sizning bir martalik 1 oylik kanalga kirish huquqingiz tugadi.\n\n` +
                `Qayta to'lov qilib Octo to'lov tizimi bilan yana bir oylik kanal foydalanish huquqiga ega bo'ling.\n\n` +
                `Rahmat.`;

            await this.bot.api.sendMessage(
                user.telegramId,
                message,
                {reply_markup: keyboard}
            );

            logger.info(`Handled expired subscription for user ${user.telegramId}`);
        } catch (error) {
            logger.error(`Error handling expired user ${user.telegramId}:`, error);
        }
    }
}
