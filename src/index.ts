import 'reflect-metadata';
import { http, Request, Response } from '@google-cloud/functions-framework';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import express, { Express } from 'express';
import { AppModule } from './app.module';

let bootstrapping: Promise<Express> | undefined;

function bootstrap(): Promise<Express> {
  if (!bootstrapping) {
    bootstrapping = (async () => {
      const server = express();
      const app = await NestFactory.create(AppModule, new ExpressAdapter(server), {
        logger: ['error', 'warn', 'log'],
      });
      await app.init();
      return server;
    })();
  }

  return bootstrapping;
}

// functions-framework ships Express 4 typings while Nest 11 uses Express 5, so the request pair
// has to cross an untyped boundary. At runtime Express re-applies its own prototypes to req/res.
type RawRequestHandler = (req: unknown, res: unknown) => void;

// Cloud Functions entry point. Keep the name in sync with --entry-point in cloudbuild.yaml.
http('telegramBot', async (req: Request, res: Response) => {
  const server = await bootstrap();
  (server as unknown as RawRequestHandler)(req, res);
});
