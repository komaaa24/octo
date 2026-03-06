// To Do

// 1. run an interval to check users' subs status daily
// 2. sth

import {SubscriptionMonitorService} from '../services/subscription-monitor.service';
import logger from '../utils/logger';
import {AutoPaymentMonitorService} from "../services/auto-payment-monitor.service";
import {UserSubscriptionExpirationService} from "../services/user-subscription-expiration.service";

export class SubscriptionChecker {
    private subscriptionMonitorService: SubscriptionMonitorService;
    private autoPaymentMonitorService: AutoPaymentMonitorService;
    private userSubscriptionExpirationService: UserSubscriptionExpirationService;
    private checkInterval: NodeJS.Timeout;

    constructor(
        subscriptionMonitorService: SubscriptionMonitorService,
        autoPaymentMonitorService: AutoPaymentMonitorService,
        userSubscriptionExpirationService: UserSubscriptionExpirationService
    ) {
        this.subscriptionMonitorService = subscriptionMonitorService;
        this.autoPaymentMonitorService = autoPaymentMonitorService;
        this.userSubscriptionExpirationService = userSubscriptionExpirationService;
    }
    async start(): Promise<void> {
        // Optional startup run; useful to avoid noisy startup processing in dev.
        const runOnStart = process.env.SUBSCRIPTION_CHECK_RUN_ON_START !== 'false';
        if (runOnStart) {
            await this.runChecks();
        } else {
            logger.info('Skipping initial subscription checks because SUBSCRIPTION_CHECK_RUN_ON_START=false');
        }

        // Then run every 24 hours
        this.checkInterval = setInterval(() => {
            this.runChecks();
        }, 24 * 60 * 60 * 1000); // 24 hours
//
        logger.info('Subscription checker started');
    }

    stop(): void {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
        }
        logger.info('Subscription checker stopped');
    }

    private async runChecks(): Promise<void> {
        try {
            logger.info('Running subscription checks...');

            // Check for expiring subscriptions and send warnings
            await this.subscriptionMonitorService.checkExpiringSubscriptions();

            // Handle expired subscriptions
            await this.subscriptionMonitorService.handleExpiredSubscriptions();
            logger.info('Subscription checks completed for onetime users.');

            // Handle expired UserSubscription documents (new model)
            logger.info('Running UserSubscription expiration checks...');
            await this.userSubscriptionExpirationService.handleExpiredSubscriptions();
            logger.info('UserSubscription expiration checks completed.');

            logger.info('Running auto payment checks...');
            const autoPaymentEnabled = process.env.AUTO_PAYMENT_CHECKS_ENABLED !== 'false';
            if (autoPaymentEnabled) {
                await this.autoPaymentMonitorService.processAutoPayments();
                logger.info('Auto payment checks completed.');
            } else {
                logger.info('Auto payment checks are disabled by AUTO_PAYMENT_CHECKS_ENABLED=false');
            }


            //TODO: later uncomment this.
            logger.info('Running auto payment checks for UserSubscription model...');
            // await this.autoPaymentMonitorService.processAutoPaymentsWithUserSubscriptionModel();
            logger.info('Auto payment checks completed. for UserSubscription model...');



        } catch (error) {
            logger.error('Error running subscription checks:', error);
        }
    }
}
