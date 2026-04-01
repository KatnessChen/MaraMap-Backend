import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

describe('StatsController', () => {
  let controller: StatsController;

  const mockStatsService = {
    getParticipantStats: jest.fn(),
    refreshAllStats: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [StatsController],
      providers: [{ provide: StatsService, useValue: mockStatsService }],
    }).compile();

    controller = module.get<StatsController>(StatsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getStats', () => {
    it('should return stats for a participant', async () => {
      const mockData = { participant_name: 'Davis', fm_count: 10 };
      mockStatsService.getParticipantStats.mockResolvedValueOnce(mockData);

      const result = await controller.getStats('Davis');

      expect(mockStatsService.getParticipantStats).toHaveBeenCalledWith('Davis');
      expect(result).toEqual(mockData);
    });

    it('should return a not-found message when no data exists', async () => {
      mockStatsService.getParticipantStats.mockResolvedValueOnce(null);

      const result = await controller.getStats('Unknown');

      expect(result).toEqual({ message: 'No stats found for participant: Unknown' });
    });

    it('should throw BadRequestException when participant is missing', async () => {
      await expect(controller.getStats(undefined as any)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockStatsService.getParticipantStats).not.toHaveBeenCalled();
    });
  });

  describe('refreshStats', () => {
    it('should trigger a stats refresh and return success message', async () => {
      mockStatsService.refreshAllStats.mockResolvedValueOnce(undefined);

      const result = await controller.refreshStats();

      expect(mockStatsService.refreshAllStats).toHaveBeenCalled();
      expect(result).toEqual({
        message: 'Participant statistics refresh initiated successfully.',
      });
    });
  });
});
