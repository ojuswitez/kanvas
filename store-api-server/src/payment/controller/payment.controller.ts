import {
  Controller,
  HttpException,
  Post,
  Req,
  Headers,
  HttpStatus,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { CurrentUser } from 'src/decoraters/user.decorator';
import { JwtAuthGuard } from 'src/authentication/guards/jwt-auth.guard';
import {
  PaymentProviderEnum,
  PaymentService,
  PaymentStatus,
  StripePaymentIntent,
} from 'src/payment/service/payment.service';
import { UserEntity } from 'src/user/entity/user.entity';
import { Lock } from 'async-await-mutex-lock';
import { UserService } from 'src/user/service/user.service';

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

@Controller('payment')
export class PaymentController {
  nftLock: Lock<number>;

  constructor(
    private paymentService: PaymentService,
    private userService: UserService
  ) {
    this.nftLock = new Lock<number>();
  }

  @Post('/stripe-webhook')
  async stripeWebhook(
    @Headers('stripe-signature') signature: string,
    @Req() request: any,
  ) {
    if (!endpointSecret) {
      throw new HttpException('Stripe not enabled', HttpStatus.BAD_REQUEST);
    }
    // Get the signature sent by Stripe
    let constructedEvent;

    try {
      constructedEvent =
        await this.paymentService.stripe.webhooks.constructEvent(
          request.body,
          signature,
          endpointSecret,
        );
    } catch (err) {
      Logger.error(`Err on payment webhook signature verification: ${err}`);
      throw new HttpException(
        'Webhook signature verification failed',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      await this.paymentService.webhookHandler(constructedEvent)
    } catch (error) {
      new HttpException('', HttpStatus.UNPROCESSABLE_ENTITY);
    }

    throw new HttpException('', HttpStatus.NO_CONTENT);
  }

  @Post('/create-payment-intent')
  @UseGuards(JwtAuthGuard)
  async createPayment(
    @CurrentUser() user: UserEntity,
  ): Promise<StripePaymentIntent> {
    await this.nftLock.acquire(user.id);

    let stripePaymentIntent: StripePaymentIntent;
    try {
      const preparedPayment = await this.paymentService.preparePayment(user.id, PaymentProviderEnum.STRIPE)
      stripePaymentIntent = await this.paymentService.createStripePayment(preparedPayment.amount, user);
      await this.paymentService.createPayment(PaymentProviderEnum.STRIPE, stripePaymentIntent.id, preparedPayment.nftOrder.id)
    } catch (err: any) {
      Logger.error(err);
      throw new HttpException(
        'Unable to place the order',
        HttpStatus.BAD_REQUEST,
      );
    } finally {
      this.nftLock.release(user.id);
    }
    return stripePaymentIntent;
  }
}
