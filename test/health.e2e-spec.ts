import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('GET /health-check (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return 200', () => {
    return request(app.getHttpServer()).get('/health-check').expect(200);
  });

  it('should return status ok', () => {
    return request(app.getHttpServer())
      .get('/health-check')
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('ok');
      });
  });

  it('should return a valid ISO 8601 timestamp', () => {
    return request(app.getHttpServer())
      .get('/health-check')
      .expect(200)
      .expect((res) => {
        const { timestamp } = res.body;
        expect(typeof timestamp).toBe('string');
        expect(new Date(timestamp).toISOString()).toBe(timestamp);
      });
  });

  it('should not return unexpected fields', () => {
    return request(app.getHttpServer())
      .get('/health-check')
      .expect(200)
      .expect((res) => {
        expect(Object.keys(res.body).sort()).toEqual(['status', 'timestamp']);
      });
  });
});
