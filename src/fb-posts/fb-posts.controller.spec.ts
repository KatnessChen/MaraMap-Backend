import { Test, TestingModule } from '@nestjs/testing';
import { FbPostsController } from './fb-posts.controller';
import { FbPostsService } from './fb-posts.service';

describe('FbPostsController', () => {
  let controller: FbPostsController;
  let service: FbPostsService;

  const mockFbPostsService = {
    findAll: jest.fn(),
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
      await controller.getPosts(2, 5, '馬拉松', '2026-01-01', '2026-01-31', 'race', 'user-1');
      expect(service.findAll).toHaveBeenCalledWith(
        'user-1',
        2,
        5,
        '馬拉松',
        '2026-01-01',
        '2026-01-31',
        'race',
      );
    });
  });

  describe('getLocations', () => {
    it('should call service.findLocations', async () => {
      await controller.getLocations('馬拉松', '2026-01-01', '2026-01-31', 'race', 'user-1');
      expect(service.findLocations).toHaveBeenCalledWith(
        'user-1',
        '馬拉松',
        '2026-01-01',
        '2026-01-31',
        'race',
      );
    });
  });

  describe('getCategories', () => {
    it('should call service.getCategories', async () => {
      await controller.getCategories('user-1');
      expect(service.getCategories).toHaveBeenCalledWith('user-1');
    });
  });
});
