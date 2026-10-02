import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppConfig } from '../../config/configuration';

export const SWAGGER_PATH = 'docs';

/**
 * Development and review convenience, not part of the deployed surface:
 * `swaggerEnabled` defaults to false when NODE_ENV is production.
 *
 * It documents only endpoints that are already reachable, so serving it in
 * production would expose nothing new -- but a public API explorer invites
 * traffic nobody asked for, and the deployed contract is the README plus the
 * burst script. Set SWAGGER_ENABLED=true on a deployed instance to turn it on
 * temporarily, for instance to walk someone through the API.
 */
export const setupSwagger = (app: INestApplication, config: AppConfig): void => {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Seat Reservation Service')
      .setDescription(
        [
          'Sells assigned seats under heavy contention. A seat is never sold',
          'twice, a user never exceeds their limit, and a retried request',
          'never books twice.',
          '',
          '**To try the secured endpoints:** call `POST /auth/token`, copy the',
          '`token`, then click **Authorize** and paste it. For `POST /shows`',
          'use the `x-admin-token` scheme with the ADMIN_TOKEN value instead.',
          '',
          'Money is always an integer number of paise. Identity always comes',
          'from the JWT subject -- a `user_id` in a request body is stripped',
          'and ignored.',
        ].join('\n'),
      )
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer')
      .addApiKey(
        { type: 'apiKey', name: 'x-admin-token', in: 'header' },
        'x-admin-token',
      )
      .addTag('Auth', 'Mint tokens for testing')
      .addTag('Shows', 'Create a show, inspect its seat map')
      .addTag('Reservations', 'The contended path')
      .addTag('Health', 'Liveness and readiness')
      .addTag('Metrics', 'Prometheus exposition')
      .build(),
  );

  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    swaggerOptions: {
      // Survives the page reloads you will inevitably do while testing.
      persistAuthorization: true,
      displayRequestDuration: true,
      tryItOutEnabled: true,
    },
    customSiteTitle: `Seat Reservation API (${config.env})`,
  });
};
