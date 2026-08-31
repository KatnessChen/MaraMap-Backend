import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { FbPostsController, RequestWithAdmin } from './fb-posts.controller';
import { FbPostsService } from './fb-posts.service';
import { AuthService } from '../auth/auth.service';
import { AdminGuard } from '../auth/guards/admin.guard';

/** Only `isAdmin` matters to the controller — the rest of Express's Request is never touched. */
function mockReq(isAdmin: boolean): RequestWithAdmin {
  return { isAdmin } as unknown as RequestWithAdmin;
}

describe('FbPostsController', () => {
  let controller: FbPostsController;
  let service: FbPostsService;

  const mockFbPostsService = {
    findAll: jest.fn(),
    findOne: jest.fn(),
    fuzzySearch: jest.fn(),
    create: jest.fn(),
    createUploadUrl: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    findLocations: jest.fn(),
    getCategories: jest.fn(),
  };

  const ORIGINAL_USER_ID = process.env.USER_ID;

  beforeEach(async () => {
    process.env.USER_ID = 'default-user';
    const module: TestingModule = await Test.createTestingModule({
      controllers: [FbPostsController],
      providers: [
        {
          provide: FbPostsService,
          useValue: mockFbPostsService,
        },
        {
          provide: AuthService,
          useValue: { verifyAdminToken: jest.fn().mockResolvedValue(false) },
        },
        AdminGuard,
        Reflector,
      ],
    }).compile();

    controller = module.get<FbPostsController>(FbPostsController);
    service = module.get<FbPostsService>(FbPostsService);
  });

  afterAll(() => {
    process.env.USER_ID = ORIGINAL_USER_ID;
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getPosts', () => {
    it("ignores a non-admin caller's ?user_id= override and uses the site default", async () => {
      const req = mockReq(false);
      await controller.getPosts(
        req,
        2,
        5,
        '馬拉松',
        '2026-01-01',
        '2026-01-31',
        'race',
        'visible',
        'desc',
        undefined,
        'user-1',
        undefined,
        undefined,
        undefined,
        undefined,
      );
      expect(service.findAll).toHaveBeenCalledWith(
        'default-user',
        2,
        5,
        '馬拉松',
        '2026-01-01',
        '2026-01-31',
        'race',
        'visible',
        'desc',
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });

    it('honors ?user_id= when the caller is an authenticated admin', async () => {
      const req = mockReq(true);
      await controller.getPosts(
        req,
        1,
        10,
        undefined,
        undefined,
        undefined,
        undefined,
        'visible',
        'desc',
        undefined,
        'user-1',
        undefined,
        undefined,
        undefined,
        undefined,
      );
      expect(service.findAll).toHaveBeenCalledWith(
        'user-1',
        1,
        10,
        undefined,
        undefined,
        undefined,
        undefined,
        'visible',
        'desc',
        undefined,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });
  });

  describe('getPostById', () => {
    it("ignores a non-admin caller's ?user_id= override", async () => {
      const req = mockReq(false);
      await controller.getPostById(req, 'post-123', 'user-1');
      expect(service.findOne).toHaveBeenCalledWith(
        'default-user',
        'post-123',
        false,
      );
    });

    it('honors ?user_id= when the caller is an authenticated admin', async () => {
      const req = mockReq(true);
      await controller.getPostById(req, 'post-123', 'user-1');
      expect(service.findOne).toHaveBeenCalledWith('user-1', 'post-123', true);
    });
  });

  describe('updatePost', () => {
    it('should call service.update', async () => {
      const updateDto = { title: 'Updated' };
      await controller.updatePost('post-123', updateDto, 'user-1');
      expect(service.update).toHaveBeenCalledWith(
        'user-1',
        'post-123',
        updateDto,
      );
    });
  });

  describe('deletePost', () => {
    it('should call service.remove', async () => {
      await controller.deletePost('post-123', 'user-1');
      expect(service.remove).toHaveBeenCalledWith('user-1', 'post-123');
    });
  });

  describe('getLocations', () => {
    it("ignores a non-admin caller's ?user_id= override", async () => {
      await controller.getLocations(
        mockReq(false),
        '馬拉松',
        undefined,
        '2026-01-01',
        '2026-01-31',
        'race',
        'user-1',
        undefined,
      );
      expect(service.findLocations).toHaveBeenCalledWith(
        'default-user',
        '馬拉松',
        undefined,
        '2026-01-01',
        '2026-01-31',
        'race',
        true,
      );
    });

    it('honors ?user_id= when the caller is an authenticated admin', async () => {
      await controller.getLocations(
        mockReq(true),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'user-1',
        undefined,
      );
      expect(service.findLocations).toHaveBeenCalledWith(
        'user-1',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );
    });
  });

  describe('getCategories', () => {
    it("ignores a non-admin caller's ?user_id= override", async () => {
      await controller.getCategories(mockReq(false), 'user-1');
      expect(service.getCategories).toHaveBeenCalledWith('default-user');
    });

    it('honors ?user_id= when the caller is an authenticated admin', async () => {
      await controller.getCategories(mockReq(true), 'user-1');
      expect(service.getCategories).toHaveBeenCalledWith('user-1');
    });
  });

  describe('createPost', () => {
    it('should call service.create with the target user and dto', async () => {
      const dto = {
        title: '手動文章',
        event_date: '2024-05-01',
        category: '馬拉松',
      };
      await controller.createPost(dto, 'user-1');
      expect(service.create).toHaveBeenCalledWith('user-1', dto);
    });
  });

  describe('createPostUploadUrl', () => {
    it('should call service.createUploadUrl with the target user and content type', async () => {
      await controller.createPostUploadUrl(
        { contentType: 'video/mp4' },
        'user-1',
      );
      expect(service.createUploadUrl).toHaveBeenCalledWith(
        'user-1',
        'video/mp4',
      );
    });
  });
});
