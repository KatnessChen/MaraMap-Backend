import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as compression from 'compression';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(compression());

  app.enableCors({
    // Allow frontend, local dev, and environment-specified origins
    origin: (origin, callback) => {
      const allowedOrigins = [
        'http://localhost',
        'http://127.0.0.1',
        'http://192.168.',
        process.env.CORS_ORIGIN,
      ].filter(Boolean);

      if (
        !origin ||
        process.env.CORS_ORIGIN === '*' ||
        allowedOrigins.some((ao) => origin.startsWith(ao as string))
      ) {
        callback(null, true);
      } else {
        console.warn(`⚠️ CORS blocked for origin: ${origin}`);
        callback(new Error(`CORS blocked by server configuration`));
      }
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
  });

  app.setGlobalPrefix('api/v1', {
    exclude: ['health-check'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  if (process.env.NODE_ENV !== 'production') {
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
    SwaggerModule.setup('api/docs', app, document, {
      customSiteTitle: 'MaraMap API Docs',
      swaggerOptions: {
        filter: true,
        docExpansion: 'none',
        persistAuthorization: true,
      },
    });
  }

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
