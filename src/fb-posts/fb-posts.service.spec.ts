import { Test, TestingModule } from '@nestjs/testing';
import {
  InternalServerErrorException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { FbPostsService } from './fb-posts.service';
import { SupabaseService } from '../supabase/supabase.service';
import { R2Service } from '../storage/r2.service';

describe('FbPostsService', () => {
  let service: FbPostsService;

  const mockR2Service = {
    delete: jest.fn().mockResolvedValue(undefined),
    copy: jest.fn().mockResolvedValue(undefined),
    upload: jest
      .fn()
      .mockImplementation((key: string) =>
        Promise.resolve(`https://cdn.example.com/${key}`),
      ),
    keyFromUrl: jest.fn((uri: string) =>
      uri?.startsWith('https://cdn.example.com/')
        ? uri.replace('https://cdn.example.com/', '')
        : null,
    ),
  };

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
    insert: jest.fn().mockReturnThis(),
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
        { provide: R2Service, useValue: mockR2Service },
      ],
    }).compile();

    service = module.get<FbPostsService>(FbPostsService);
    mockR2Service.delete.mockClear();
    mockR2Service.delete.mockResolvedValue(undefined);
    mockR2Service.upload.mockClear();
    mockR2Service.copy.mockClear();
    mockR2Service.copy.mockResolvedValue(undefined);
    mockSupabaseClient.insert.mockClear();
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
    // claimTmpMedia builds permanent URIs from R2_PUBLIC_URL (set in prod).
    const origPublicUrl = process.env.R2_PUBLIC_URL;
    beforeAll(() => {
      process.env.R2_PUBLIC_URL = 'https://cdn.example.com';
    });
    afterAll(() => {
      if (origPublicUrl === undefined) delete process.env.R2_PUBLIC_URL;
      else process.env.R2_PUBLIC_URL = origPublicUrl;
    });

    it('should update a post', async () => {
      const updateDto = { title: 'New' };
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: { id: '1', media: [], ...updateDto }, error: null }),
      );

      const result = await service.update('user-123', '1', updateDto);
      expect(mockSupabaseClient.update).toHaveBeenCalledWith(updateDto);
      expect(result.title).toBe('New');
    });

    it('claims tmp media, deletes removed R2 objects, keeps unchanged ones, and rewrites cover', async () => {
      const tmpUri = 'https://cdn.example.com/tmp/user-123/new.png';
      const permUri =
        'https://cdn.example.com/your_facebook_activity/posts/media/new.png';
      const keptUri = 'https://cdn.example.com/manual/user-123/kept.jpg';
      const removedUri = 'https://cdn.example.com/manual/user-123/gone.jpg';

      // 1st awaited supabase call: SELECT existing media (to diff for cleanup).
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({
          data: {
            media: [
              { uri: keptUri, type: 'photo' },
              { uri: removedUri, type: 'photo' },
            ],
          },
          error: null,
        }),
      );
      // 2nd: the UPDATE itself.
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: { id: '1', media: [], title: 'x' }, error: null }),
      );

      await service.update('user-123', '1', {
        media: [
          { uri: keptUri, type: 'photo' },
          { uri: tmpUri, type: 'photo' },
        ],
        cover_image: tmpUri,
      });

      // tmp item promoted out of tmp/ into the shared media prefix
      expect(mockR2Service.copy).toHaveBeenCalledWith(
        'tmp/user-123/new.png',
        'your_facebook_activity/posts/media/new.png',
      );
      // removed object deleted; kept object left alone
      expect(mockR2Service.delete).toHaveBeenCalledWith(
        'manual/user-123/gone.jpg',
      );
      expect(mockR2Service.delete).not.toHaveBeenCalledWith(
        'manual/user-123/kept.jpg',
      );
      // persisted media has the claimed (permanent) uri + kept uri; cover rewritten
      const updated = mockSupabaseClient.update.mock.calls.at(-1)![0];
      expect(updated.media).toEqual([
        { uri: keptUri, type: 'photo' },
        { uri: permUri, type: 'photo' },
      ]);
      expect(updated.cover_image).toBe(permUri);
    });

    it('does not touch media/R2 when the patch omits media (e.g. hide toggle)', async () => {
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: { id: '1', media: [], is_hidden: true }, error: null }),
      );

      await service.update('user-123', '1', { is_hidden: true });

      expect(mockR2Service.copy).not.toHaveBeenCalled();
      expect(mockR2Service.delete).not.toHaveBeenCalled();
      const updated = mockSupabaseClient.update.mock.calls.at(-1)![0];
      expect(updated).not.toHaveProperty('media');
    });
  });

  describe('create', () => {
    // claimTmpMedia builds permanent URIs from R2_PUBLIC_URL (set in prod).
    const origPublicUrl = process.env.R2_PUBLIC_URL;
    beforeAll(() => {
      process.env.R2_PUBLIC_URL = 'https://cdn.example.com';
    });
    afterAll(() => {
      if (origPublicUrl === undefined) delete process.env.R2_PUBLIC_URL;
      else process.env.R2_PUBLIC_URL = origPublicUrl;
    });

    it('inserts a new post scoped to the user with a millisecond fb_timestamp and defaults', async () => {
      const before = Date.now();
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({
          data: { id: 'new-1', media: [], title: '手動文章' },
          error: null,
        }),
      );

      const result = await service.create('user-123', {
        title: '手動文章',
        event_date: '2024-05-01',
        category: '馬拉松',
      });

      const inserted = mockSupabaseClient.insert.mock.calls[0][0];
      expect(inserted.user_id).toBe('user-123');
      expect(inserted.title).toBe('手動文章');
      expect(inserted.event_date).toBe('2024-05-01');
      // Millisecond timestamp — well above any FB second-based timestamp.
      expect(inserted.fb_timestamp).toBeGreaterThanOrEqual(before);
      // Optional fields default rather than being left undefined.
      expect(inserted.content).toBe('');
      expect(inserted.sub_categories).toEqual([]);
      expect(inserted.tags).toEqual([]);
      expect(inserted.media).toEqual([]);
      expect(inserted.is_hidden).toBe(false);
      expect(inserted.source).toBe('manual');
      expect(result.id).toBe('new-1');
    });

    it('throws when supabase returns an error', async () => {
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: null, error: { message: 'duplicate key' } }),
      );

      await expect(
        service.create('user-123', {
          title: 'x',
          event_date: '2024-05-01',
          category: '旅遊',
        }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('claims tmp media into the permanent path and rewrites uris + cover', async () => {
      const tmpUri = 'https://cdn.example.com/tmp/user-123/123-abc.png';
      const permUri =
        'https://cdn.example.com/your_facebook_activity/posts/media/123-abc.png';
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: { id: 'new-1', media: [] }, error: null }),
      );

      await service.create('user-123', {
        title: '有圖文章',
        event_date: '2024-05-01',
        category: '旅遊',
        media: [{ uri: tmpUri, type: 'photo' }],
        cover_image: tmpUri,
      });

      expect(mockR2Service.copy).toHaveBeenCalledWith(
        'tmp/user-123/123-abc.png',
        'your_facebook_activity/posts/media/123-abc.png',
      );
      expect(mockR2Service.delete).toHaveBeenCalledWith(
        'tmp/user-123/123-abc.png',
      );
      const inserted = mockSupabaseClient.insert.mock.calls[0][0];
      expect(inserted.media).toEqual([{ uri: permUri, type: 'photo' }]);
      expect(inserted.cover_image).toBe(permUri);
    });

    it('keeps the tmp uri when the claim copy fails (best-effort)', async () => {
      const tmpUri = 'https://cdn.example.com/tmp/user-123/x.png';
      mockR2Service.copy.mockRejectedValueOnce(new Error('R2 down'));
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: { id: 'new-2', media: [] }, error: null }),
      );

      await service.create('user-123', {
        title: 't',
        event_date: '2024-05-01',
        category: '旅遊',
        media: [{ uri: tmpUri, type: 'photo' }],
        cover_image: tmpUri,
      });

      const inserted = mockSupabaseClient.insert.mock.calls[0][0];
      expect(inserted.media).toEqual([{ uri: tmpUri, type: 'photo' }]);
      expect(inserted.cover_image).toBe(tmpUri);
      expect(mockR2Service.delete).not.toHaveBeenCalled();
    });
  });

  describe('uploadMedia', () => {
    const file = (mimetype: string, size = 1024) =>
      ({
        buffer: Buffer.from('media'),
        mimetype,
        size,
        originalname: 'x',
      }) as Express.Multer.File;

    it('uploads a valid image to R2 and returns key + url + photo type', async () => {
      const result = await service.uploadMedia('user-123', file('image/png'));
      expect(mockR2Service.upload).toHaveBeenCalledTimes(1);
      const [key, , contentType] = mockR2Service.upload.mock.calls[0];
      expect(key).toMatch(/^tmp\/user-123\/.*\.png$/);
      expect(contentType).toBe('image/png');
      expect(result.key).toBe(key);
      expect(result.url).toBe(`https://cdn.example.com/${key}`);
      expect(result.type).toBe('photo');
    });

    it('uploads a valid video to R2 and returns video type', async () => {
      const result = await service.uploadMedia('user-123', file('video/mp4'));
      const [key] = mockR2Service.upload.mock.calls[0];
      expect(key).toMatch(/^tmp\/user-123\/.*\.mp4$/);
      expect(result.type).toBe('video');
    });

    it('rejects an unsupported mime type without touching R2', async () => {
      await expect(
        service.uploadMedia('user-123', file('application/pdf')),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockR2Service.upload).not.toHaveBeenCalled();
    });

    it('rejects an image over the 8MB limit without touching R2', async () => {
      await expect(
        service.uploadMedia('user-123', file('image/jpeg', 9 * 1024 * 1024)),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockR2Service.upload).not.toHaveBeenCalled();
    });

    it('accepts a video within the 64MB limit that would exceed the image limit', async () => {
      const result = await service.uploadMedia(
        'user-123',
        file('video/mp4', 40 * 1024 * 1024),
      );
      expect(result.type).toBe('video');
      expect(mockR2Service.upload).toHaveBeenCalledTimes(1);
    });

    it('rejects a video over the 64MB limit without touching R2', async () => {
      await expect(
        service.uploadMedia('user-123', file('video/mp4', 65 * 1024 * 1024)),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockR2Service.upload).not.toHaveBeenCalled();
    });

    it('rejects when no file is provided', async () => {
      await expect(
        service.uploadMedia(
          'user-123',
          undefined as unknown as Express.Multer.File,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
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

    it('best-effort deletes each media object without failing the delete', async () => {
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({
          data: {
            id: 'post-1',
            media: [
              { uri: 'https://cdn.example.com/a.jpg' },
              { uri: 'https://cdn.example.com/b.jpg' },
            ],
          },
          error: null,
        }),
      );

      await service.remove('user-123', 'post-1');
      expect(mockR2Service.delete).toHaveBeenCalledWith('a.jpg');
      expect(mockR2Service.delete).toHaveBeenCalledWith('b.jpg');
    });

    it('does not throw when R2 deletion rejects', async () => {
      mockR2Service.delete.mockRejectedValueOnce(new Error('R2 down'));
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({
          data: {
            id: 'post-1',
            media: [{ uri: 'https://cdn.example.com/a.jpg' }],
          },
          error: null,
        }),
      );

      await expect(service.remove('user-123', 'post-1')).resolves.toBeDefined();
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
          // findLocations selects country via the `country:metadata->>country`
          // alias, so it reads a top-level `country`, not `metadata.country`.
          country: 'Taiwan',
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

  describe('trip management', () => {
    it('getTripSuggestions ranks near-date/same-city candidates and excludes the current trip', async () => {
      mockSupabaseClient.then
        .mockImplementationOnce((resolve) =>
          resolve({
            data: {
              id: 'anchor',
              event_date: '2016-02-28',
              trip_id: 'anchor',
              metadata: { country: '日本', city: '東京' },
            },
            error: null,
          }),
        )
        .mockImplementationOnce((resolve) =>
          resolve({
            data: [
              {
                id: 'c1',
                event_date: '2016-02-27',
                title: '賽前準備',
                category: '旅遊',
                media: [],
                metadata: { country: '日本', city: '東京' },
                trip_id: null,
              },
              {
                id: 'c2',
                event_date: '2016-03-02',
                title: '晴空塔',
                category: '旅遊',
                media: [],
                metadata: { country: '日本', city: '東京' },
                trip_id: 'otherTrip',
              },
              {
                id: 'inTrip',
                event_date: '2016-02-28',
                title: 'x',
                category: '旅遊',
                media: [],
                metadata: { country: '日本' },
                trip_id: 'anchor',
              },
            ],
            error: null,
          }),
        );

      const res = await service.getTripSuggestions('user-123', 'anchor');
      expect(res).toHaveLength(2); // the same-trip candidate is excluded
      expect(res[0].postId).toBe('c1'); // 1 day beats 3 days
      expect(res[0].reason).toContain('同國');
      expect(res.find((r) => r.postId === 'c2')?.alreadyInOtherTrip).toBe(true);
    });

    it('getTripSuggestions throws NotFound when the anchor is missing', async () => {
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: null, error: null }),
      );
      await expect(
        service.getTripSuggestions('user-123', 'missing'),
      ).rejects.toThrow(NotFoundException);
    });

    it('addToTrip auto-creates a trip when the anchor has none', async () => {
      mockSupabaseClient.then
        .mockImplementationOnce((resolve) =>
          resolve({ data: { id: 'anchor', trip_id: null }, error: null }),
        )
        .mockImplementationOnce((resolve) => resolve({ error: null }))
        .mockImplementationOnce((resolve) => resolve({ error: null }))
        .mockImplementationOnce((resolve) =>
          resolve({ data: [], error: null }),
        );
      const res = await service.addToTrip('user-123', 'anchor', 'target');
      expect(mockSupabaseClient.update).toHaveBeenCalledWith({
        trip_id: 'anchor',
      });
      expect(Array.isArray(res)).toBe(true);
    });

    it('removeFromTrip blocks removing the primary while members remain', async () => {
      mockSupabaseClient.then
        .mockImplementationOnce((resolve) =>
          resolve({ data: { id: 'T', trip_id: 'T' }, error: null }),
        )
        .mockImplementationOnce((resolve) =>
          resolve({ data: [{ id: 'other' }], error: null }),
        );
      await expect(service.removeFromTrip('user-123', 'T')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('removeFromTrip removes a secondary post', async () => {
      mockSupabaseClient.then
        .mockImplementationOnce((resolve) =>
          resolve({ data: { id: 'sec', trip_id: 'T' }, error: null }),
        )
        .mockImplementationOnce((resolve) => resolve({ error: null }))
        .mockImplementationOnce((resolve) =>
          resolve({ data: [], error: null }),
        );
      const res = await service.removeFromTrip('user-123', 'sec');
      expect(Array.isArray(res)).toBe(true);
    });

    it('makePrimary re-keys the whole group to the promoted post', async () => {
      mockSupabaseClient.then
        .mockImplementationOnce((resolve) =>
          resolve({ data: { id: 'newP', trip_id: 'oldT' }, error: null }),
        )
        .mockImplementationOnce((resolve) => resolve({ error: null }))
        .mockImplementationOnce((resolve) =>
          resolve({ data: [], error: null }),
        );
      const res = await service.makePrimary('user-123', 'newP');
      expect(mockSupabaseClient.update).toHaveBeenCalledWith({
        trip_id: 'newP',
      });
      expect(Array.isArray(res)).toBe(true);
    });
  });
});
