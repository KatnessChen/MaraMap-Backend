import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as compression from 'compression';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Cloud Run terminates TLS and proxies every request, so without this
  // Express (and therefore the rate limiter) sees the proxy's IP for every
  // request instead of the real client — trust the first hop's
  // X-Forwarded-For entry.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // Exclude the FB-import streaming endpoint — compression buffers chunks to
  // improve ratio, which would delay live log lines reaching the browser.
  app.use(
    compression({
      filter: (req, res) => {
        if (req.path.startsWith('/api/v1/admin/fb-import')) return false;
        return compression.filter(req, res);
      },
    }),
  );

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
