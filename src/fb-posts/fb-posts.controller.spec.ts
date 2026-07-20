import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { FbPostsController } from './fb-posts.controller';
import { FbPostsService } from './fb-posts.service';
import { AuthService } from '../auth/auth.service';
import { AdminGuard } from '../auth/guards/admin.guard';

describe('FbPostsController', () => {
  let controller: FbPostsController;
  let service: FbPostsService;

  const mockFbPostsService = {
    findAll: jest.fn(),
    findOne: jest.fn(),
    fuzzySearch: jest.fn(),
    create: jest.fn(),
    uploadMedia: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    findLocations: jest.fn(),
    getCategories: jest.fn(),
  };

  beforeEach(async () => {
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

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getPosts', () => {
    it('should call service.findAll with correct params', async () => {
      const mockReq = { isAdmin: false };
      await controller.getPosts(
        mockReq,
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
        'user-1',
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
  });

  describe('getPostById', () => {
    it('should call service.findOne', async () => {
      const mockReq = { isAdmin: false };
      await controller.getPostById(mockReq, 'post-123', 'user-1');
      expect(service.findOne).toHaveBeenCalledWith('user-1', 'post-123', false);
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
    it('should call service.findLocations', async () => {
      await controller.getLocations(
        '馬拉松',
        undefined,
        '2026-01-01',
        '2026-01-31',
        'race',
        'user-1',
        undefined,
      );
      expect(service.findLocations).toHaveBeenCalledWith(
        'user-1',
        '馬拉松',
        undefined,
        '2026-01-01',
        '2026-01-31',
        'race',
        true,
      );
    });
  });

  describe('getCategories', () => {
    it('should call service.getCategories', async () => {
      await controller.getCategories('user-1');
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

  describe('uploadPostMedia', () => {
    it('should call service.uploadMedia with the target user and file', async () => {
      const file = { mimetype: 'image/png' } as Express.Multer.File;
      await controller.uploadPostMedia(file, 'user-1');
      expect(service.uploadMedia).toHaveBeenCalledWith('user-1', file);
    });
  });
});
