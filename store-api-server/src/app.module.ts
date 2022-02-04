import { APP_GUARD } from '@nestjs/core';
import { Module, MiddlewareConsumer } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { CategoryModule } from './category/category.module';
import { NftModule } from './nft/nft.module';
import { UserModule } from './user/user.module';
import { AuthProviderModule } from './auth-provider/auth-provider.module';
import { AuthenticationModule } from './authentication/authentication.module';
import { DbModule } from './db.module';
import { PaymentModule } from './payment/payment.module';
import { LoggerMiddleware } from './middleware/logger';
import { CookieSessionMiddleware } from './middleware/cookie_session';
import { ProxiedThrottlerGuard } from './decoraters/proxied_throttler';
import { RATE_LIMIT_WINDOW_SECS, RATE_LIMIT } from 'src/constants';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    AuthenticationModule,
    CategoryModule,
    NftModule,
    UserModule,
    AuthProviderModule,
    PaymentModule,
    DbModule,
    ThrottlerModule.forRoot({
      ttl: RATE_LIMIT_WINDOW_SECS,
      limit: RATE_LIMIT,
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ProxiedThrottlerGuard }],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CookieSessionMiddleware, LoggerMiddleware).forRoutes('*');
  }
}
