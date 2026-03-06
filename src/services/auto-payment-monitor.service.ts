import {Bot, Context, SessionFlavor} from 'grammy';
import {IUserDocument, UserModel} from '../database/models/user.model';
import {PaymentCardTokenDto} from "../payment-providers/click-subs-api/dto/request/payment-card-token.dto";
import logger from '../utils/logger';
import {SubscriptionType} from "../config";
import {CardType, UserCardsModel} from "../database/models/user-cards.model";
import {SubscriptionService} from "./subscription.service";
import {Plan} from "../database/models/plans.model";
import {PaymentService} from "./payment.service";
import {UserSubscription} from "../database/models/user-subscription.model";

interface SessionData {
    pendingSubscription?: {
        type: SubscriptionType
    };
}

type BotContext = Context & SessionFlavor<SessionData>;

export class AutoPaymentMonitorService {
    private bot: Bot<BotContext>;
    private paymentService: PaymentService;
    private subscriptionService: SubscriptionService;

    constructor(bot: Bot<BotContext>, subscriptionService: SubscriptionService) {
        this.subscriptionService = subscriptionService;
        this.bot = bot;
        this.paymentService = new PaymentService();
    }

    async processAutoPayments(): Promise<void> {
        // Get users whose subscriptions expire today
        const now = new Date();

        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        // Find users whose subscriptions expire today and are still active
        const expiringUsers = await UserModel.find({
            subscriptionEnd: {
                $lte: now
            },
            subscriptionType: 'subscription',
            // isActive: true, //TODO: Think and discuss about this
            $or: [
                {lastAttemptedAutoSubscriptionAt: {$exists: false}},
                {lastAttemptedAutoSubscriptionAt: {$lt: startOfToday}}
            ]
        });


        logger.info(`Found ${expiringUsers.length} users with subscriptions expiring today`);

        for (const user of expiringUsers) {
            const planId = user.plans?.[0]?._id || 'NoPlan';
            logger.info(`Processing auto payment candidate user ${user.telegramId}, planId: ${planId}`);
            await this.attemptAutoPayment(user, planId as string);
        }

    }

    //TODO: we need to add deletion of old expired userSubscriptions entities before creating new ones.
    async processAutoPaymentsWithUserSubscriptionModel(): Promise<void> {
        const now = new Date();
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        //todo: it is just for test, we can remove this after making sure it works
        // const userIds = [176041025, 1129669089, 6010448225, 1083408, 85939027, 1487957834];

        const expiringUsers = await UserSubscription.aggregate([
            {
                $match: {
                    // telegramId: { $in: userIds },
                    endDate: { $lte: now },
                    status: 'expired',
                    subscriptionType: 'subscription',
                    $or: [
                        { lastAttemptedAutoSubscriptionAt: { $exists: false } },
                        { lastAttemptedAutoSubscriptionAt: { $lt: startOfToday } }
                    ]
                }
            },
            {
                $sort: { endDate: -1 }
            },
            {
                $group: {
                    _id: { telegramId: "$telegramId", plan: "$plan" },
                    subscription: { $first: "$$ROOT" }
                }
            },
            {
                $replaceRoot: { newRoot: "$subscription" }
            }
        ]);

        logger.info(`Found ${expiringUsers.length} unique (telegramId + plan) subscriptions to delete & process`);

        // ✅ Step 1: Delete exactly these subscriptions by their ObjectIds
        const idsToDelete = expiringUsers.map(sub => sub._id);
        const deleteResult = await UserSubscription.deleteMany({ _id: { $in: idsToDelete } });
        logger.info(`Deleted ${deleteResult.deletedCount} expired subscriptions before reprocessing.`);

        // ✅ Step 2: Process auto-payments
        for (const user of expiringUsers) {
            logger.info(`Attempting auto-payment for user ${user.telegramId}, plan ${user.plan}`);

            const actualUser = await UserModel.findOne({ telegramId: user.telegramId });
            if (!actualUser) {
                logger.warn(`No user found for telegramId=${user.telegramId}`);
                continue;
            }

            await this.attemptAutoPayment(actualUser, user.plan.toString());
        }
    }



    private async attemptAutoPayment(user: IUserDocument, planId?: string): Promise<void> {
        try {
            logger.info(`Attempting auto payment for user ${user.telegramId}`);


            user.lastAttemptedAutoSubscriptionAt = new Date();
            user.attemptCount = user.attemptCount + 1;
            await user.save();

            // Prepare payment request
            const request = new PaymentCardTokenDto();
            request.userId = user._id as string;
            request.telegramId = user.telegramId;
            request.planId = planId as string;


            const userCard = await UserCardsModel.findOne({userId: user._id});

            if (!userCard) {
                logger.info(`User card not found for user ${user.telegramId}`);
                return;
            }

            let paymentSuccess: any = false;

            switch (userCard.cardType) {
                case CardType.CLICK:
                    const clickResponse = await this.paymentService.paymentWithClickSubsApi(request);
                    paymentSuccess = clickResponse;
                    break;

                case CardType.PAYME:
                    const paymeResponse = await this.paymentService.paymentWithPaymeSubsApi(request);
                    paymentSuccess = paymeResponse as boolean;
                    break;

                case CardType.UZCARD:
                    const uzcardResponse = await this.paymentService.paymentWithUzcardSubsApi(request);
                    paymentSuccess = uzcardResponse;
                    break;

                default:
                    logger.error(`Unsupported card type: ${userCard.cardType} for user ${user.telegramId}`);
                    return;
            }

            if (userCard.cardType === CardType.UZCARD && paymentSuccess) {
                logger.info(`Auto payment successful for user ${user.telegramId}`);

                const plan = await Plan.findById(planId);

                if (!plan) {
                    logger.error(`No plan found with id ${planId} for user ${user.telegramId}`);
                    return;
                }

                await this.subscriptionService.createSubscription(user._id as string, plan, user.username);
                await this.notifySuccessfulPaymentWithQr(user._id as string, paymentSuccess.qrCodeUrl);
                return;
            }
            if (paymentSuccess) {
                logger.info(`Auto payment successful for user ${user.telegramId}`);

                const plan = await Plan.findById(planId);

                if (!plan) {
                    logger.error(`No plan found with id ${planId} for user ${user.telegramId}`);
                    return;
                }

                await this.subscriptionService.createSubscription(user._id as string, plan, user.username);
                await this.notifySuccessfulPayment(user._id as string);
            } else {
                logger.error(`Auto payment failed for user ${user.telegramId}`);
                await this.notifyFailedPayment(user);
            }


        } catch (error) {
            logger.error(`Error processing auto payment for user ${user.telegramId}:`, error);
        }
    }

    private async notifySuccessfulPayment(userId: string): Promise<void> {
        try {
            const user = await UserModel.findById(userId);
            if (!user) {
                logger.error(`User not found for ID: ${userId}`);
                return;
            }
            user.attemptCount = 0;
            await user.save();
            const endDate = new Date(user.subscriptionEnd);
            const endDateFormatted = `${endDate.getDate().toString().padStart(2, '0')}.${(endDate.getMonth() + 1).toString().padStart(2, '0')}.${endDate.getFullYear()}`;


            const message = `✅ Avtomatik to'lov muvaffaqiyatli amalga oshirildi!\n\n` +
                `Sizning obunangiz ${endDateFormatted} gacha uzaytirildi.\n`;

            await this.bot.api.sendMessage(
                user.telegramId,
                message
            );


            logger.info(`Sent successful payment notification to user ${user.telegramId}`);
        } catch (error) {
            logger.error(`Error sending successful payment notification to user ${userId}:`, error);
        }
    }

    private async notifySuccessfulPaymentWithQr(userId: string, qrCodeUrl?: string): Promise<void> {
        try {
            const user = await UserModel.findById(userId);
            if (!user) {
                logger.error(`User not found for ID: ${userId}`);
                return;
            }

            user.attemptCount = 0;
            await user.save();

            const endDate = new Date(user.subscriptionEnd);
            const endDateFormatted = `${endDate.getDate().toString().padStart(2, '0')}.${(endDate.getMonth() + 1).toString().padStart(2, '0')}.${endDate.getFullYear()}`;

            //TODO: qaysi sport turiga to'lov bo'lganini aytish kerak
            let message = `✅ Avtomatik to'lov muvaffaqiyatli amalga oshirildi!\n\n` +
                `Sizning obunangiz ${endDateFormatted} gacha uzaytirildi.\n`;

            if (qrCodeUrl) {
                message += `\n🧾 <a href="${qrCodeUrl}">To'lov cheki (QR)</a>`;
            }

            await this.bot.api.sendMessage(
                user.telegramId,
                message,
                {
                    parse_mode: "HTML"
                }
            );

            logger.info(`Sent successful payment notification (with QR) to user ${user.telegramId}`);
        } catch (error) {
            logger.error(`Error sending successful payment notification to user ${userId}:`, error);
        }
    }


    private async notifyFailedPayment(user: IUserDocument): Promise<void> {
        try {
            const message = `❌ Avtomatik to'lov amalga oshmadi!\n\n` +
                `Kartangizda mablag' yetarli emas yoki boshqa muammo yuzaga keldi.\n`;

            if (user.attemptCount >= 30) {

                logger.info(`Changing isActive and isKickedOut for user ${user.telegramId}`);

                user.isActive = false;
                user.isKickedOut = true;
                await user.save();
                await this.bot.api.sendMessage(
                    user.telegramId,
                    message
                );
                logger.info(`Sent failed payment notification to user ${user.telegramId}`);
            } else {
                logger.info(`Did not send failed payment notification to user: ${user.telegramId} because attempt count is less than 30`);
            }
        } catch (error) {
            logger.error(`Error sending failed payment notification to user ${user.telegramId}:`, error);
        }
    }
}
