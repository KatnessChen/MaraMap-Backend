import { Test, TestingModule } from '@nestjs/testing';
import {
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
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
    ilike: jest.fn().mockReturnThis(),
    contains: jest.fn().mockReturnThis(),
    neq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
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
        {
          provide: CACHE_MANAGER,
          useValue: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
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
      expect(mockSupabaseClient.eq).toHaveBeenCalledWith('category', '馬拉松');
      expect(mockSupabaseClient.or).toHaveBeenCalledWith(
        'content.ilike.%race%,title.ilike.%race%',
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
      // First call: lock check query
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: { is_ai_editing_locked: false }, error: null }),
      );
      // Second call: actual update
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: { id: '1', media: [], ...updateDto }, error: null }),
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

  describe('findOne', () => {
    it('should throw NotFoundException when post not found', async () => {
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: null, error: { message: 'Not found' } }),
      );
      await expect(service.findOne('user-123', 'missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should not filter by is_hidden when isAdmin is true', async () => {
      const mockPost = {
        id: 'post-1',
        title: 'Hidden Post',
        media: [],
        is_hidden: true,
      };
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: mockPost, error: null }),
      );
      const result = await service.findOne('user-123', 'post-1', true);
      expect(result).toMatchObject({ id: 'post-1', cover_image: null });
    });
  });

  describe('fuzzySearch', () => {
    it('should return paginated search results', async () => {
      const mockData = [{ id: '1', title: 'Race Day', media: [] }];
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: mockData, count: 1, error: null }),
      );

      const result = await service.fuzzySearch('user-123', {
        q: 'race',
        limit: 10,
        offset: 0,
      });
      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
    });

    it('should throw InternalServerErrorException on Supabase error', async () => {
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: null, count: 0, error: { message: 'DB error' } }),
      );
      await expect(service.fuzzySearch('user-123', {})).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('findLocations', () => {
    it('should return empty array when userId is missing', async () => {
      const result = await service.findLocations('');
      expect(result).toEqual([]);
    });

    it('should return mapped location data for posts with GPS media', async () => {
      const mockPosts = [
        {
          id: 'p1',
          title: 'Race',
          event_date: '2026-01-01',
          category: 'marathon',
          media: [{ lat: 25.0, lng: 121.0, uri: 'img.jpg', type: 'photo' }],
          metadata: { country: 'Taiwan' },
        },
      ];
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: mockPosts, error: null }),
      );

      const result = await service.findLocations('user-123');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        lat: 25.0,
        lng: 121.0,
        country: 'Taiwan',
      });
    });

    it('should filter out posts with no GPS media', async () => {
      const mockPosts = [
        {
          id: 'p1',
          title: 'No GPS',
          event_date: '2026-01-01',
          category: 'daily',
          media: [],
          metadata: {},
        },
      ];
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: mockPosts, error: null }),
      );

      const result = await service.findLocations('user-123');
      expect(result).toHaveLength(0);
    });

    it('should return empty array on Supabase error', async () => {
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: null, error: { message: 'error' } }),
      );

      const result = await service.findLocations('user-123');
      expect(result).toEqual([]);
    });
  });

  describe('getCategories', () => {
    it('should return empty array when userId is missing', async () => {
      const result = await service.getCategories('');
      expect(result).toEqual([]);
    });

    it('should aggregate categories and return counts', async () => {
      const mockData = [
        { category: '馬拉松', sub_categories: [] },
        { category: '馬拉松', sub_categories: [] },
        { category: '旅遊', sub_categories: [] },
      ];
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: mockData, error: null }),
      );

      const result = await service.getCategories('user-123');
      expect(result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: '馬拉松', count: 2 }),
          expect.objectContaining({ name: '旅遊', count: 1 }),
        ]),
      );
    });
  });

  describe('findAll', () => {
    it('should throw InternalServerErrorException on Supabase error', async () => {
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: null, count: 0, error: { message: 'DB error' } }),
      );
      await expect(service.findAll('user-123')).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should normalizePost with cover_image fallback from media', async () => {
      const mockPost = {
        id: '1',
        media: [{ uri: 'images/photo.jpg', type: 'photo' }],
        cover_image: '',
      };
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: [mockPost], count: 1, error: null }),
      );

      const result = await service.findAll('user-123');
      expect(result.data[0].cover_image).toMatch(/images\/photo\.jpg$/);
    });
  });
});
