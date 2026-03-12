import { Test, TestingModule } from '@nestjs/testing';
import { FbPostsService } from './fb-posts.service';
import { SupabaseService } from '../supabase/supabase.service';

describe('FbPostsService', () => {
  let service: FbPostsService;
  let supabaseService: SupabaseService;

  const mockSupabaseClient = {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    // Make thenable to support await
    then: jest.fn(function(resolve) {
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
    supabaseService = module.get<SupabaseService>(SupabaseService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findAll', () => {
    it('should call supabase client with correct pagination and filters', async () => {
      mockSupabaseClient.then.mockImplementationOnce((resolve) => 
        resolve({ data: [], count: 0, error: null })
      );

      const userId = 'user-123';
      await service.findAll(userId, 1, 10, '馬拉松', '2026-01-01', '2026-03-01', 'race');

      expect(mockSupabaseClient.from).toHaveBeenCalledWith('fb_posts');
      expect(mockSupabaseClient.eq).toHaveBeenCalledWith('user_id', userId);
      expect(mockSupabaseClient.eq).toHaveBeenCalledWith('category', '馬拉松');
      expect(mockSupabaseClient.gte).toHaveBeenCalledWith('event_date', '2026-01-01');
      expect(mockSupabaseClient.lte).toHaveBeenCalledWith('event_date', '2026-03-01');
      expect(mockSupabaseClient.or).toHaveBeenCalledWith(expect.stringContaining('race'));
      expect(mockSupabaseClient.range).toHaveBeenCalledWith(0, 9);
    });
  });

  describe('findLocations', () => {
    it('should only return posts with valid GPS coordinates', async () => {
      const mockData = [
        { id: '1', media: [{ lat: 25, lng: 121 }] },
        { id: '2', media: [{ lat: null, lng: null }] },
        { id: '3', media: [] },
      ];
      mockSupabaseClient.then.mockImplementationOnce((resolve) => 
        resolve({ data: mockData, error: null })
      );

      const results = await service.findLocations('user-123');

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('1');
    });
  });

  describe('getCategories', () => {
    it('should correctly count and group categories', async () => {
      const mockData = [
        { category: '馬拉松' },
        { category: '馬拉松' },
        { category: '旅遊' },
        { category: null },
      ];
      mockSupabaseClient.then.mockImplementationOnce((resolve) => 
        resolve({ data: mockData, error: null })
      );

      const results = await service.getCategories('user-123');

      expect(results).toEqual(
        expect.arrayContaining([
          { name: '馬拉松', count: 2 },
          { name: '旅遊', count: 1 },
          { name: 'unknown', count: 1 },
        ]),
      );
    });
  });
});
