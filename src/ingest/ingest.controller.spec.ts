import { Test, TestingModule } from '@nestjs/testing';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { CreateIngestDto } from './dto/create-ingest.dto';
import { Request } from 'express';
import { AuthUser } from '../auth/strategies/supabase.strategy';

const mockIngestService = {
  createIngest: jest.fn(),
};

describe('IngestController', () => {
  let controller: IngestController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [IngestController],
      providers: [{ provide: IngestService, useValue: mockIngestService }],
    })
      .overrideGuard(SupabaseAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<IngestController>(IngestController);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should call ingestService.createIngest with dto and userId', async () => {
    const dto: CreateIngestDto = {
      source_id: 'fb_123',
      original_url: 'https://facebook.com/post/123',
      raw_text: 'Some marathon post',
    };
    const userId = 'user-uuid-abc';
    const mockReq = {
      user: { userId, email: 'test@example.com' },
    } as Request & { user: AuthUser };
    const expectedResult = {
      message: 'Ingestion accepted',
      postId: 'post-uuid-456',
    };

    mockIngestService.createIngest.mockResolvedValue(expectedResult);

    const result = await controller.create(dto, mockReq);

    expect(mockIngestService.createIngest).toHaveBeenCalledWith(dto, userId);
    expect(result).toEqual(expectedResult);
  });

  it('should return the service result directly', async () => {
    const dto: CreateIngestDto = {
      source_id: 'fb_existing',
      original_url: 'https://facebook.com/post/existing',
      raw_text: 'Existing post',
    };
    const mockReq = { user: { userId: 'uid', email: 'a@b.com' } } as Request & {
      user: AuthUser;
    };
    const existingResult = {
      message: 'Already exists',
      postId: 'existing-post-id',
    };

    mockIngestService.createIngest.mockResolvedValue(existingResult);

    const result = await controller.create(dto, mockReq);

    expect(result).toEqual(existingResult);
  });
});
