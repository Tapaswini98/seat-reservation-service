import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { loadConfig } from './config/configuration';
import { AuthModule } from './modules/auth/auth.module';
import { DatabaseModule } from './modules/database/database.module';
import { HealthModule } from './modules/health/health.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { ReservationModule } from './modules/reservation/reservation.module';
import { ShowModule } from './modules/show/show.module';
import { AllExceptionsFilter } from './shared/exceptions/all-exceptions.filter';
import { JwtAuthGuard } from './shared/guards/jwt-auth.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [loadConfig], cache: true }),
    DatabaseModule,
    MetricsModule,
    AuthModule,
    ShowModule,
    ReservationModule,
    HealthModule,
  ],
  providers: [
    // Authentication is on by default; routes opt out with @Public().
    // The safe failure mode for a newly added endpoint is "requires a token".
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
