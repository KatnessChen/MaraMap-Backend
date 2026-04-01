import { Test, TestingModule } from '@nestjs/testing';
import { StatsService } from './stats.service';
import { SupabaseService } from '../supabase/supabase.service';

describe('StatsService', () => {
  let service: StatsService;

  const mockSupabaseClient = {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    ilike: jest.fn().mockReturnThis(),
    single: jest.fn().mockReturnThis(),
    neq: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockReturnThis(),
    then: jest.fn(function (resolve) {
      return resolve({ data: null, error: null });
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSupabaseClient.then.mockImplementation(function (resolve) {
      return resolve({ data: null, error: null });
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatsService,
        {
          provide: SupabaseService,
          useValue: {
            getClient: jest.fn().mockReturnValue(mockSupabaseClient),
          },
        },
      ],
    }).compile();

    service = module.get<StatsService>(StatsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getParticipantStats', () => {
    it('should return stats for a known participant', async () => {
      const mockData = { participant_name: 'Davis', fm_count: 5 };
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: mockData, error: null }),
      );

      const result = await service.getParticipantStats('Davis');

      expect(mockSupabaseClient.from).toHaveBeenCalledWith('participant_stats');
      expect(mockSupabaseClient.ilike).toHaveBeenCalledWith(
        'participant_name',
        'Davis',
      );
      expect(result).toEqual(mockData);
    });

    it('should return null when Supabase returns an error', async () => {
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: null, error: { message: 'Not found' } }),
      );

      const result = await service.getParticipantStats('Unknown');

      expect(result).toBeNull();
    });
  });

  describe('refreshAllStats', () => {
    it('should return early when fetching posts fails', async () => {
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: null, error: { message: 'DB error' } }),
      );

      await service.refreshAllStats();

      expect(mockSupabaseClient.upsert).not.toHaveBeenCalled();
    });

    it('should aggregate stats and upsert for known participants', async () => {
      const mockPosts = [
        {
          category: 'marathon',
          metadata: {
            participants: [
              {
                name: 'Davis',
                distance: '全馬',
                stats: { distance_km: 42, FM_count: 3, HM_count: 0 },
              },
            ],
          },
        },
        {
          category: 'marathon',
          metadata: {
            participants: [
              {
                name: 'Rose',
                distance: '半馬',
                stats: { distance_km: 21, FM_count: 0, HM_count: 2 },
              },
            ],
          },
        },
      ];

      // First call: fetch posts
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: mockPosts, error: null }),
      );
      // Second call: upsert Davis
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ error: null }),
      );
      // Third call: upsert Rose
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ error: null }),
      );

      await service.refreshAllStats();

      expect(mockSupabaseClient.upsert).toHaveBeenCalledTimes(2);
    });

    it('should skip posts with no participants array', async () => {
      const mockPosts = [
        { category: 'travel', metadata: { participants: null } },
        { category: 'marathon', metadata: {} },
      ];

      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: mockPosts, error: null }),
      );

      await service.refreshAllStats();

      expect(mockSupabaseClient.upsert).not.toHaveBeenCalled();
    });

    it('should skip unknown participant names', async () => {
      const mockPosts = [
        {
          category: 'marathon',
          metadata: {
            participants: [
              { name: 'Unknown', distance: '全馬', stats: { distance_km: 42 } },
            ],
          },
        },
      ];

      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: mockPosts, error: null }),
      );

      await service.refreshAllStats();

      expect(mockSupabaseClient.upsert).not.toHaveBeenCalled();
    });
  });
});
