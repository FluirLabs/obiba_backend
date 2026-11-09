import 'reflect-metadata';
import { Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadWorkerConfig } from './config';
import { WorkerRuntime } from './runtime';

function boot(): WorkerRuntime {
  try {
    return new WorkerRuntime(loadWorkerConfig());
  } catch (err) {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : 'startup failed'}\n`);
    process.exit(1);
  }
}

const runtime = boot();

@Module({ providers: [{ provide: WorkerRuntime, useValue: runtime }] })
class WorkerModule implements OnApplicationBootstrap, OnApplicationShutdown {
  onApplicationBootstrap() {
    runtime.start();
  }
  async onApplicationShutdown() {
    await runtime.stop();
  }
}

NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn'] })
  .then((app) => app.enableShutdownHooks())
  .catch((err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : 'startup failed'}\n`);
    process.exit(1);
  });
