import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { loadConfig } from './config';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.create(config), { bufferLogs: true, bodyParser: false });
  configureApp(app, config);
  await app.listen(config.PORT, '0.0.0.0');
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : 'startup failed'}\n`);
  process.exit(1);
});
