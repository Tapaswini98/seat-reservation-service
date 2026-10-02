import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildDataSourceOptions } from '../../models/data-source';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        ...buildDataSourceOptions(),
        autoLoadEntities: false,
        retryAttempts: 10,
        retryDelay: 2000,
      }),
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
