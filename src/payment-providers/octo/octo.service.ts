import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { Plan } from '../../database/models/plans.model';
import { PaymentProvider, PaymentTypes, Transaction, TransactionStatus } from '../../database/models/transactions.model';
import logger from '../../utils/logger';
import { Bot, InlineKeyboard } from 'grammy';
import { UserModel } from '../../database/models/user.model';
import { SubscriptionService } from '../../services/subscription.service';

type CreatePaymentParams = {
    userId: string;
    selectedSport: string;
    telegramId?: number;
    test?: boolean;
};

@Injectable()
export class OctoService {
    private readonly preparePaymentUrl = 'https://secure.octo.uz/prepare_payment';
    private bot: Bot | null = null;

    constructor(private readonly configService: ConfigService) {
        // Initialize bot if token is available
        const botToken = this.configService.get<string>('BOT_TOKEN');
        if (botToken) {
            this.bot = new Bot(botToken);
        }
    }

    private formatInitTime(date: Date = new Date()): string {
        const year = date.getFullYear();
        const month = `${date.getMonth() + 1}`.padStart(2, '0');
        const day = `${date.getDate()}`.padStart(2, '0');
        const hours = `${date.getHours()}`.padStart(2, '0');
        const minutes = `${date.getMinutes()}`.padStart(2, '0');
        const seconds = `${date.getSeconds()}`.padStart(2, '0');

        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }

    private resolvePlanName(selectedSport: string): string {
        return selectedSport === 'wrestling' ? 'Yakka kurash' : 'Futbol';
    }

    /**
     * Resolve notify URL with sane fallbacks so prod to'lovlar xatoga tushmaydi.
     */
    private resolveNotifyUrl(): string {
        const explicit = this.configService.get<string>('OCTO_NOTIFY_URL');
        if (explicit) return explicit;

        const basePayme = this.configService.get<string>('BASE_PAYME_URL');
        if (basePayme) {
            try {
                const url = new URL(basePayme);
                url.pathname = '/api/octo/notify';
                url.search = '';
                return url.toString();
            } catch (e) {
                logger.warn(`Failed to derive notify URL from BASE_PAYME_URL: ${basePayme}`);
            }
        }

        throw new Error('OCTO_NOTIFY_URL is required to receive payment status callbacks');
    }

    async createOneTimePayment(params: CreatePaymentParams): Promise<{
        payUrl: string;
        octoPaymentUUID: string;
        shopTransactionId: string;
    }> {
        const octoShopId = this.configService.get<number>('OCTO_SHOP_ID');
        const octoSecret = this.configService.get<string>('OCTO_SECRET_KEY');

        if (!octoShopId || !octoSecret) {
            throw new Error('Octo credentials are not configured');
        }

        const planName = this.resolvePlanName(params.selectedSport);
        const plan = await Plan.findOne({ name: planName });

        if (!plan) {
            throw new Error(`Plan not found for sport: ${params.selectedSport}`);
        }

        const shopTransactionId = `${plan._id}-${params.userId}-${Date.now()}`;
        const testModeEnabled = params.test || this.configService.get<string>('OCTO_TEST_MODE') === 'true';
        const overrideAmount = testModeEnabled
            ? Number(this.configService.get<number>('OCTO_TEST_AMOUNT'))
            : undefined;

        const payload: Record<string, any> = {
            octo_shop_id: Number(octoShopId),
            octo_secret: octoSecret,
            shop_transaction_id: shopTransactionId,
            auto_capture: true,
            init_time: this.formatInitTime(),
            total_sum: overrideAmount ?? plan.price,
            currency: 'UZS',
            description: `One-time payment for ${planName}`,
        };

        const returnUrl = this.configService.get<string>('OCTO_RETURN_URL');
        const notifyUrl = this.resolveNotifyUrl();
        const language = this.configService.get<string>('OCTO_LANGUAGE') || 'uz';
        if (!notifyUrl) {
            throw new Error('OCTO_NOTIFY_URL is required to receive payment status callbacks');
        }
        if (testModeEnabled) payload.test = true;
        if (returnUrl) payload.return_url = returnUrl;
        payload.notify_url = notifyUrl;
        if (language) payload.language = language;

        logger.info(`Creating Octo payment with payload: ${JSON.stringify(payload, null, 2)}`);

        try {
            const response = await axios.post(this.preparePaymentUrl, payload, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000,
            });

            logger.info(`Octo API response: ${JSON.stringify(response.data, null, 2)}`);

            if (!response.data || response.data.error) {
                logger.error(`Octo error: ${JSON.stringify(response.data)}`);
                throw new Error(response.data?.errMessage || 'Failed to create Octo payment');
            }

            const data = response.data.data || response.data;

            // Save transaction to database
            await Transaction.create({
                provider: PaymentProvider.OCTO,
                paymentType: PaymentTypes.ONETIME,
                amount: plan.price,
                userId: params.userId,
                planId: plan._id,
                status: TransactionStatus.CREATED,
                transId: data.octo_payment_UUID,
                selectedSport: params.selectedSport,
            });

            return {
                payUrl: data.octo_pay_url,
                octoPaymentUUID: data.octo_payment_UUID,
                shopTransactionId,
            };
        } catch (error: any) {
            logger.error('Failed to initiate Octo payment', error);
            throw new Error(error?.message || 'Failed to initiate Octo payment');
        }
    }

    /**
     * Handle Octo push notification.
     */
    async handleNotification(body: any): Promise<void> {
        logger.info(`Octo notification received: ${JSON.stringify(body, null, 2)}`);

        const { octo_payment_UUID: paymentUUID, status } = body || {};

        if (!paymentUUID) {
            logger.error('Octo notification missing payment UUID');
            throw new Error('Missing payment UUID');
        }

        if (!status) {
            logger.error(`Octo notification missing status for payment ${paymentUUID}`);
            throw new Error('Missing payment status');
        }

        logger.info(`Processing Octo payment ${paymentUUID} with status: ${status}`);

        const tx = await Transaction.findOne({ transId: paymentUUID, provider: PaymentProvider.OCTO });
        if (!tx) {
            logger.warn(`Octo notify: transaction not found for ${paymentUUID}`);
            return;
        }

        // Update transaction status
        // Octo docs: succeeded/payed/paid/captured -> success, canceled/failed/rejected/expired -> failure
        switch ((status as string)?.toLowerCase()) {
            case 'succeeded':
            case 'paid':
            case 'payed': // older spelling in docs
            case 'captured':
                tx.status = TransactionStatus.PAID;
                break;
            case 'canceled':
            case 'cancelled':
            case 'failed':
            case 'rejected':
            case 'expired':
                tx.status = TransactionStatus.CANCELED;
                break;
            default:
                logger.info(`Octo notify: received unhandled status ${status} for ${paymentUUID}`);
                break;
        }

        await tx.save();
        logger.info(`Transaction ${paymentUUID} status updated to: ${tx.status}`);

        // If payment is successful, create subscription and notify user
        if (tx.status === TransactionStatus.PAID) {
            try {
                logger.info(`Starting subscription creation for payment ${paymentUUID}`);

                const plan = await Plan.findById(tx.planId);
                const user = await UserModel.findById(tx.userId);

                if (!plan) {
                    logger.error(`Octo notify: plan not found for transaction ${paymentUUID}`);
                    return;
                }

                if (!user) {
                    logger.error(`Octo notify: user not found for transaction ${paymentUUID}`);
                    return;
                }

                // Create subscription
                let subscription: any;
                try {
                    if (!this.bot) {
                        logger.error('BOT_TOKEN not configured, cannot create subscription or send message');
                        return;
                    }

                    // Create subscription based on selected sport
                    if (tx.selectedSport === 'wrestling') {
                        subscription = await this.createWrestlingSubscription(user, plan);
                    } else {
                        subscription = await this.createFootballSubscription(user, plan);
                    }

                    logger.info(`Subscription created successfully for user ${user._id}`);

                } catch (subscriptionError) {
                    logger.error(`Error creating subscription for payment ${paymentUUID}:`, subscriptionError);
                    // Continue to try sending channel link even if subscription creation fails
                }

                // Always mark user as subscribed and use the appropriate channel
                const selectedSport = tx.selectedSport || 'football'; // Default to football if not set
                if (selectedSport === 'wrestling') {
                    await UserModel.updateOne({ _id: user._id }, { $set: { subscribedTo: 'wrestling' } });
                } else {
                    await UserModel.updateOne({ _id: user._id }, { $set: { subscribedTo: 'football' } });
                }

                // Send channel invite link
                await this.sendChannelInviteMessage(user, selectedSport, subscription);

            } catch (err) {
                logger.error(`Error processing Octo paid notification for ${paymentUUID}:`, err);
            }
        }
    }

    private async createFootballSubscription(user: any, plan: any) {
        // Create football subscription
        const subscriptionData = {
            user: user._id,
            plan: plan._id,
            telegramId: user.telegramId,
            planName: plan.name,
            subscriptionType: 'subscription',
            startDate: new Date(),
            
            endDate: new Date(Date.now() + plan.duration * 24 * 60 * 60 * 1000),
            isActive: true,
            autoRenew: false,
            status: 'active'
        };

        return await import('../../database/models/user-subscription.model').then(
            ({ UserSubscription }) => UserSubscription.create(subscriptionData)
        );
    }

    private async createWrestlingSubscription(user: any, plan: any) {
        // Update user's wrestling subscription dates
        await UserModel.updateOne(
            { _id: user._id },
            {
                $set: {
                    isActiveSubsForWrestling: true,
                    subscriptionStartForWrestling: new Date(),
                    subscriptionEndForWrestling: new Date(Date.now() + plan.duration * 24 * 60 * 60 * 1000)
                }
            }
        );

        // Create user subscription record
        const subscriptionData = {
            user: user._id,
            plan: plan._id,
            telegramId: user.telegramId,
            planName: plan.name,
            subscriptionType: 'subscription',
            startDate: new Date(),
            endDate: new Date(Date.now() + plan.duration * 24 * 60 * 60 * 1000),
            isActive: true,
            autoRenew: false,
            status: 'active'
        };

        return await import('../../database/models/user-subscription.model').then(
            ({ UserSubscription }) => UserSubscription.create(subscriptionData)
        );
    }

    private async sendChannelInviteMessage(user: any, selectedSport: string, subscription: any) {
        try {
            if (!this.bot) {
                logger.error('Bot not initialized, cannot send channel invite message');
                return;
            }

            const channelId = selectedSport === 'wrestling'
                ? this.configService.get<string>('WRESTLING_CHANNEL_ID')
                : this.configService.get<string>('CHANNEL_ID');

            if (!channelId) {
                logger.error(`Channel ID not configured for sport: ${selectedSport}`);
                return;
            }

            // Create private invite link
            const privateLink = await this.bot.api.createChatInviteLink(channelId, {
                member_limit: 1,
                expire_date: 0,
                creates_join_request: false,
            });

            logger.info(`Channel invite link created: ${privateLink.invite_link}`);

            const keyboard = new InlineKeyboard()
                .url('🔗 Kanalga kirish', privateLink.invite_link)
                .row()
                .text('🔙 Asosiy menyu', 'main_menu');

            // Format end date
            let endDate: Date;
            if (selectedSport === 'wrestling' && subscription?.user?.subscriptionEndForWrestling) {
                endDate = subscription.user.subscriptionEndForWrestling;
            } else if (subscription?.subscriptionEnd) {
                endDate = subscription.subscriptionEnd;
            } else {
                // Default to 30 days from now if no subscription data
                endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
            }

            const endFormatted = `${endDate.getDate().toString().padStart(2, '0')}.${(endDate.getMonth() + 1).toString().padStart(2, '0')}.${endDate.getFullYear()}`;

            const message = `🎉 Tabriklaymiz! To'lov muvaffaqiyatli amalga oshirildi.\n\n⏰ Obuna tugash muddati: ${endFormatted}\n\nQuyidagi havola orqali kanalga kirishingiz mumkin:`;

            if (user.telegramId) {
                await this.bot.api.sendMessage(Number(user.telegramId), message, {
                    reply_markup: keyboard,
                    parse_mode: 'HTML',
                });
                logger.info(`Channel invite message sent to user ${user.telegramId}`);
            } else {
                logger.warn(`User ${user._id} has no telegramId, cannot send invite link`);
            }

        } catch (error) {
            logger.error(`Failed to send channel invite message:`, error);
        }
    }
}
