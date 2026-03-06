import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { OctoService } from './octo.service';
import logger from '../../utils/logger';
import { Body, HttpStatus, Post } from "@nestjs/common";

@Controller('octo')
export class OctoController {
    constructor(private readonly octoService: OctoService) {}

    @Get('one-time')
    async createOneTimePayment(
        @Query('userId') userId: string,
        @Query('selectedSport') selectedSport: string,
        @Query('telegramId') telegramId: string,
        @Query('test') test: string,
        @Res() res: Response,
    ) {
        if (!userId || !selectedSport) {
            return res.status(400).json({ message: 'userId and selectedSport are required' });
        }

        try {
            const result = await this.octoService.createOneTimePayment({
                userId,
                selectedSport,
                telegramId: telegramId ? Number(telegramId) : undefined,
                test: test === 'true',
            });

            if (!result.payUrl) {
                return res.status(502).json({ message: 'Octo payment URL was not returned' });
            }

            return res.redirect(result.payUrl);
        } catch (error: any) {
            logger.error('Error creating Octo payment', error);
            return res.status(400).json({ message: error?.message || 'Failed to create payment' });
        }
    }

    @Post('notify')
    async handleNotification(@Body() body: any, @Res() res: Response) {
        try {
            await this.octoService.handleNotification(body);
            return res.status(HttpStatus.OK).json({ received: true });
        } catch (error: any) {
            logger.error('Error handling Octo notification', error);
            return res.status(HttpStatus.BAD_REQUEST).json({ message: error?.message || 'Failed to process notification' });
        }
    }

    @Get('verify')
    async verifyPayment(
        @Query('paymentUUID') paymentUUID: string,
        @Res() res: Response,
    ) {
        if (!paymentUUID) {
            return res.status(HttpStatus.BAD_REQUEST).json({ message: 'paymentUUID is required' });
        }

        try {
            const result = await this.octoService.verifyAndFinalizePaymentByUUID(paymentUUID);
            return res.status(HttpStatus.OK).json({ ok: true, ...result });
        } catch (error: any) {
            logger.error('Error verifying Octo payment', error);
            return res.status(HttpStatus.BAD_REQUEST).json({ message: error?.message || 'Failed to verify payment' });
        }
    }
}
