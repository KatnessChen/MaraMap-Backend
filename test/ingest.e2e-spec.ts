import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { SupabaseService } from '../src/supabase/supabase.service';
import { SupabaseAuthGuard } from '../src/auth/guards/supabase-auth.guard';

describe('POST /api/v1/ingest (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Create a mock Supabase client
    const mockSupabaseClient = {
      from: jest.fn((table: string) => {
        if (table === 'posts') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                maybeSingle: jest.fn().mockResolvedValue({
                  data: null,
                  error: null,
                }),
              }),
            }),
            insert: jest.fn().mockReturnValue({
              select: jest.fn().mockReturnValue({
                single: jest
                  .fn()
                  .mockImplementation(async () => {
                    const id = `post-${Date.now()}-${Math.random()}`;
                    return {
                      data: { id },
                      error: null,
                    };
                  }),
              }),
            }),
          };
        }
        return {};
      }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue({
        getClient: jest.fn().mockReturnValue(mockSupabaseClient),
      })
      .overrideGuard(SupabaseAuthGuard)
      .useValue({
        canActivate: jest.fn((context) => {
          // Mock user attached to request
          const request = context.switchToHttp().getRequest();
          request.user = {
            userId: 'mock-user-uuid-12345',
            email: 'test@example.com',
          };
          return true;
        }),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.setGlobalPrefix('api/v1', { exclude: ['health-check'] });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Happy Path', () => {
    it('should return 202 Accepted with valid payload', () => {
      return request(app.getHttpServer())
        .post('/api/v1/ingest')
        .send({
          source_id: 'fb_test_12345',
          original_url: 'https://facebook.com/post/12345',
          raw_text: 'Marathon training post',
        })
        .expect(202)
        .expect((res) => {
          expect(res.body.message).toBe('Ingestion accepted');
          expect(res.body.postId).toBeDefined();
          expect(typeof res.body.postId).toBe('string');
        });
    });

    it('should accept optional raw_images array', () => {
      return request(app.getHttpServer())
        .post('/api/v1/ingest')
        .send({
          source_id: 'fb_test_67890',
          original_url: 'https://facebook.com/post/67890',
          raw_text: 'Hiking adventure',
          raw_images: [
            'https://example.com/img1.jpg',
            'https://example.com/img2.jpg',
          ],
        })
        .expect(202)
        .expect((res) => {
          expect(res.body.postId).toBeDefined();
        });
    });

    it('should return 202 even without raw_images', () => {
      return request(app.getHttpServer())
        .post('/api/v1/ingest')
        .send({
          source_id: 'fb_test_no_images',
          original_url: 'https://facebook.com/post/text-only',
          raw_text: 'Text only post',
        })
        .expect(202);
    });
  });

  describe('DTO Validation - Required Fields', () => {
    it('should reject request without source_id (400)', () => {
      return request(app.getHttpServer())
        .post('/api/v1/ingest')
        .send({
          original_url: 'https://facebook.com/post/test',
          raw_text: 'Test post',
        })
        .expect(400)
        .expect((res) => {
          const messages = res.body.message;
          expect(
            Array.isArray(messages)
              ? messages.some((m: string) => m.includes('source_id'))
              : messages.includes('source_id'),
          ).toBe(true);
        });
    });

    it('should reject request without raw_text (400)', () => {
      return request(app.getHttpServer())
        .post('/api/v1/ingest')
        .send({
          source_id: 'fb_test',
          original_url: 'https://facebook.com/post/test',
        })
        .expect(400)
        .expect((res) => {
          const messages = res.body.message;
          expect(
            Array.isArray(messages)
              ? messages.some((m: string) => m.includes('raw_text'))
              : messages.includes('raw_text'),
          ).toBe(true);
        });
    });

    it('should reject request without original_url (400)', () => {
      return request(app.getHttpServer())
        .post('/api/v1/ingest')
        .send({
          source_id: 'fb_test',
          raw_text: 'Test post',
        })
        .expect(400)
        .expect((res) => {
          const messages = res.body.message;
          expect(
            Array.isArray(messages)
              ? messages.some((m: string) => m.includes('original_url'))
              : messages.includes('original_url'),
          ).toBe(true);
        });
    });

    it('should reject empty source_id (400)', () => {
      return request(app.getHttpServer())
        .post('/api/v1/ingest')
        .send({
          source_id: '',
          original_url: 'https://facebook.com/post/test',
          raw_text: 'Test post',
        })
        .expect(400);
    });

    it('should reject empty raw_text (400)', () => {
      return request(app.getHttpServer())
        .post('/api/v1/ingest')
        .send({
          source_id: 'fb_test',
          original_url: 'https://facebook.com/post/test',
          raw_text: '',
        })
        .expect(400);
    });
  });

  describe('DTO Validation - URL Format', () => {
    it('should reject invalid original_url (400)', () => {
      return request(app.getHttpServer())
        .post('/api/v1/ingest')
        .send({
          source_id: 'fb_test',
          original_url: 'not-a-valid-url',
          raw_text: 'Test post',
        })
        .expect(400)
        .expect((res) => {
          const messages = res.body.message;
          expect(
            Array.isArray(messages)
              ? messages.some((m: string) => m.includes('original_url'))
              : messages.includes('original_url'),
          ).toBe(true);
        });
    });

    it('should reject invalid image URLs (400)', () => {
      return request(app.getHttpServer())
        .post('/api/v1/ingest')
        .send({
          source_id: 'fb_test',
          original_url: 'https://facebook.com/post/test',
          raw_text: 'Test post',
          raw_images: ['https://valid.com/img.jpg', 'invalid-url'],
        })
        .expect(400)
        .expect((res) => {
          const messages = res.body.message;
          expect(
            Array.isArray(messages)
              ? messages.some((m: string) => m.includes('raw_images'))
              : messages.includes('raw_images'),
          ).toBe(true);
        });
    });

    it('should accept valid URLs with query parameters', () => {
      return request(app.getHttpServer())
        .post('/api/v1/ingest')
        .send({
          source_id: 'fb_test_query_params',
          original_url:
            'https://facebook.com/post/123?utm_source=app&utm_campaign=test',
          raw_text: 'Post with query params',
        })
        .expect(202);
    });

    it('should accept valid URLs with fragments', () => {
      return request(app.getHttpServer())
        .post('/api/v1/ingest')
        .send({
          source_id: 'fb_test_fragment',
          original_url:
            'https://facebook.com/post/123#section-title',
          raw_text: 'Post with fragment',
        })
        .expect(202);
    });
  });

  describe('DTO Validation - Array Handling', () => {
    it('should reject raw_images if not array (400)', () => {
      return request(app.getHttpServer())
        .post('/api/v1/ingest')
        .send({
          source_id: 'fb_test',
          original_url: 'https://facebook.com/post/test',
          raw_text: 'Test post',
          raw_images: 'https://example.com/img.jpg', // Should be array
        })
        .expect(400);
    });

    it('should accept empty raw_images array', () => {
      return request(app.getHttpServer())
        .post('/api/v1/ingest')
        .send({
          source_id: 'fb_test_empty_images',
          original_url: 'https://facebook.com/post/test',
          raw_text: 'Test post',
          raw_images: [],
        })
        .expect(202);
    });

    it('should handle multiple images', () => {
      return request(app.getHttpServer())
        .post('/api/v1/ingest')
        .send({
          source_id: 'fb_many_images',
          original_url: 'https://facebook.com/post/images',
          raw_text: 'Photo gallery post',
          raw_images: [
            'https://example.com/img1.jpg',
            'https://example.com/img2.jpg',
            'https://example.com/img3.jpg',
          ],
        })
        .expect(202);
    });
  });

  describe('Edge Cases - Data Format', () => {
    it('should handle very long raw_text (10KB+)', () => {
      const longText = 'A'.repeat(10000);
      return request(app.getHttpServer())
        .post('/api/v1/ingest')
        .send({
          source_id: 'fb_long_text',
          original_url: 'https://facebook.com/post/long',
          raw_text: longText,
        })
        .expect(202);
    });

    it('should handle unicode and emoji in raw_text', () => {
      return request(app.getHttpServer())
        .post('/api/v1/ingest')
        .send({
          source_id: 'fb_unicode',
          original_url: 'https://facebook.com/post/unicode',
          raw_text: '你好世界 🏃‍♂️ Marathon! 日本語 한글',
        })
        .expect(202);
    });

    it('should handle special characters in raw_text', () => {
      return request(app.getHttpServer())
        .post('/api/v1/ingest')
        .send({
          source_id: 'fb_special_chars',
          original_url: 'https://facebook.com/post/special',
          raw_text: 'Test @mention #hashtag $symbol "quotes" \'apostrophe\'',
        })
        .expect(202);
    });

    it('should handle newlines and whitespace in raw_text', () => {
      return request(app.getHttpServer())
        .post('/api/v1/ingest')
        .send({
          source_id: 'fb_whitespace',
          original_url: 'https://facebook.com/post/whitespace',
          raw_text: 'First line\n\nSecond line\tTabbed\r\nWindow style',
        })
        .expect(202);
    });

    it('should handle long source_id', () => {
      return request(app.getHttpServer())
        .post('/api/v1/ingest')
        .send({
          source_id: 'fb_' + 'x'.repeat(100),
          original_url: 'https://facebook.com/post/long-id',
          raw_text: 'Post with long source_id',
        })
        .expect(202);
    });
  });

  describe('Request Body Format', () => {
    it('should reject non-JSON body', () => {
      return request(app.getHttpServer())
        .post('/api/v1/ingest')
        .set('Content-Type', 'text/plain')
        .send('source_id=fb_test&original_url=...')
        .expect(400);
    });

    it('should reject extra unknown fields (forbidNonWhitelisted=true)', () => {
      return request(app.getHttpServer())
        .post('/api/v1/ingest')
        .send({
          source_id: 'fb_test_unknown',
          original_url: 'https://facebook.com/post/test',
          raw_text: 'Test post',
          unknown_field: 'should be rejected',
          another_field: 123,
        })
        .expect(400) // Rejected due to forbidNonWhitelisted
        .expect((res) => {
          // message is an array of validation errors
          expect(Array.isArray(res.body.message)).toBe(true);
          expect(
            res.body.message.some((msg: string) =>
              msg.includes('unknown_field'),
            ),
          ).toBe(true);
        });
    });
  });

  describe('Response Format', () => {
    it('should return response with postId and message', () => {
      return request(app.getHttpServer())
        .post('/api/v1/ingest')
        .send({
          source_id: 'fb_response_format',
          original_url: 'https://facebook.com/post/response',
          raw_text: 'Check response format',
        })
        .expect(202)
        .expect((res) => {
          expect(res.body).toHaveProperty('postId');
          expect(res.body).toHaveProperty('message');
          expect(res.body.postId).toBeTruthy();
          expect(res.body.message).toBeTruthy();
        });
    });

    it('should have correct HTTP status code 202', () => {
      return request(app.getHttpServer())
        .post('/api/v1/ingest')
        .send({
          source_id: 'fb_status_code',
          original_url: 'https://facebook.com/post/status',
          raw_text: 'Check status code',
        })
        .expect(202);
    });
  });
});
