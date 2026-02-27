import { Test, TestingModule } from '@nestjs/testing';
import { InternalServerErrorException } from '@nestjs/common';
import { IngestService } from './ingest.service';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateIngestDto } from './dto/create-ingest.dto';

const makeDto = (overrides?: Partial<CreateIngestDto>): CreateIngestDto => ({
  source_id: 'fb_123',
  original_url: 'https://facebook.com/post/123',
  raw_text: 'Marathon post content',
  ...overrides,
});

const mockSupabaseClient = {
  from: jest.fn(),
};

const mockSupabaseService = {
  getClient: jest.fn().mockReturnValue(mockSupabaseClient),
};

describe('IngestService', () => {
  let service: IngestService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IngestService,
        { provide: SupabaseService, useValue: mockSupabaseService },
      ],
    }).compile();

    service = module.get<IngestService>(IngestService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createIngest - idempotency', () => {
    it('should return existing postId without inserting when source_id already exists', async () => {
      const existingId = 'existing-post-uuid';
      mockSupabaseClient.from.mockReturnValue({
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: { id: existingId }, error: null }),
          }),
        }),
      });

      const result = await service.createIngest(makeDto(), 'user-uuid');

      expect(result).toEqual({ message: 'Already exists', postId: existingId });
    });
  });

  describe('createIngest - new post', () => {
    it('should insert and return new postId when source_id is new', async () => {
      const newPostId = 'new-post-uuid';
      let callCount = 0;
      mockSupabaseClient.from.mockReturnValue({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
        insert: () => ({
          select: () => ({
            single: () =>
              Promise.resolve({ data: { id: newPostId }, error: null }),
          }),
        }),
      });

      // Override to handle two separate from() calls
      callCount = 0;
      mockSupabaseClient.from.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
          };
        }
        return {
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({ data: { id: newPostId }, error: null }),
            }),
          }),
        };
      });

      const result = await service.createIngest(makeDto(), 'user-uuid');

      expect(result).toEqual({
        message: 'Ingestion accepted',
        postId: newPostId,
      });
    });
  });

  describe('createIngest - error handling', () => {
    it('should throw InternalServerErrorException when select fails', async () => {
      mockSupabaseClient.from.mockReturnValue({
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: null, error: { message: 'DB error' } }),
          }),
        }),
      });

      await expect(
        service.createIngest(makeDto(), 'user-uuid'),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('should throw InternalServerErrorException when insert fails', async () => {
      let callCount = 0;
      mockSupabaseClient.from.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
          };
        }
        return {
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({
                  data: null,
                  error: { message: 'Insert failed' },
                }),
            }),
          }),
        };
      });

      await expect(
        service.createIngest(makeDto(), 'user-uuid'),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });
});
