import { Test, TestingModule } from '@nestjs/testing';
import { FbPostsService } from './fb-posts.service';
import { SupabaseService } from '../supabase/supabase.service';

describe('FbPostsService', () => {
  let service: FbPostsService;

  const mockSupabaseClient = {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    single: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    // Make thenable to support await
    then: jest.fn(function (resolve) {
      return resolve({ data: [], count: 0, error: null });
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FbPostsService,
        {
          provide: SupabaseService,
          useValue: {
            getClient: jest.fn().mockReturnValue(mockSupabaseClient),
          },
        },
      ],
    }).compile();

    service = module.get<FbPostsService>(FbPostsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findAll', () => {
    it('should call supabase client with correct pagination and filters', async () => {
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: [], count: 0, error: null }),
      );

      const userId = 'user-123';
      await service.findAll(
        userId,
        1,
        10,
        '馬拉松',
        '2026-01-01',
        '2026-03-01',
        'race',
      );

      expect(mockSupabaseClient.from).toHaveBeenCalledWith('fb_posts');
      expect(mockSupabaseClient.eq).toHaveBeenCalledWith('user_id', userId);
      expect(mockSupabaseClient.or).toHaveBeenCalledWith(
        expect.stringContaining('category.eq.馬拉松'),
      );
      expect(mockSupabaseClient.range).toHaveBeenCalledWith(0, 9);
    });
  });

  describe('findOne', () => {
    it('should return a single post', async () => {
      const mockPost = { id: 'post-1', title: 'Test Post', media: [] };
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: mockPost, error: null }),
      );

      const result = await service.findOne('user-123', 'post-1');
      expect(mockSupabaseClient.eq).toHaveBeenCalledWith('id', 'post-1');
      expect(result).toEqual({ ...mockPost, cover_image: null });
    });
  });

  describe('update', () => {
    it('should update a post', async () => {
      const updateDto = { title: 'New' };
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: { id: '1', ...updateDto }, error: null }),
      );

      const result = await service.update('user-123', '1', updateDto);
      expect(mockSupabaseClient.update).toHaveBeenCalledWith(updateDto);
      expect(result.title).toBe('New');
    });
  });

  describe('remove', () => {
    it('should delete a post', async () => {
      const mockDeleted = { id: 'post-1' };
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: mockDeleted, error: null }),
      );

      const result = await service.remove('user-123', 'post-1');
      expect(mockSupabaseClient.delete).toHaveBeenCalled();
      expect(mockSupabaseClient.eq).toHaveBeenCalledWith('id', 'post-1');
      expect(result).toEqual(mockDeleted);
    });
  });
});
