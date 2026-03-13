// Stub env vars BEFORE any module is imported — process.env must be set
// before NestJS providers initialise, so we use require() for AppModule.
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'stub-service-role-key';

/* eslint-disable @typescript-eslint/no-require-imports */
const { NestFactory } = require('@nestjs/core');
const { DocumentBuilder, SwaggerModule } = require('@nestjs/swagger');
const { writeFileSync } = require('fs');
const { resolve } = require('path');
const { AppModule } = require('../src/app.module');

async function generateSpec() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api/v1', { exclude: ['health-check'] });

  const config = new DocumentBuilder()
    .setTitle('MaraMap API')
    .setDescription('MaraMap Backend API — Ingestion & Content endpoints')
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'supabase-jwt',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);

  const outputPath = resolve(__dirname, '../docs/openapi.json');
  writeFileSync(outputPath, JSON.stringify(document, null, 2));

  console.log(`✅ OpenAPI spec generated → docs/openapi.json`);
  await app.close();
}

generateSpec();
