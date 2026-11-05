import { Test, TestingModule } from '@nestjs/testing';
import type { Response } from 'express';
import { AdminGuard } from '../auth/guards/admin.guard';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

describe('ChatController', () => {
  let controller: ChatController;
  const mockService = {
    respond: jest.fn(),
    listSessions: jest.fn(),
    getSession: jest.fn(),
    markRead: jest.fn(),
    archive: jest.fn(),
    restore: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [{ provide: ChatService, useValue: mockService }],
    })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(ChatController);
  });

  it('hands the question and response to the service', async () => {
    const res = {} as Response;
    const dto = { question: '問題' };

    await controller.ask(dto, res);

    expect(mockService.respond).toHaveBeenCalledWith(dto, res);
  });

  it('keeps the session page size and offset within bounds', () => {
    controller.listSessions(5000, -3, false);
    expect(mockService.listSessions).toHaveBeenCalledWith(100, 0, false);

    controller.listSessions(0, 20, true);
    expect(mockService.listSessions).toHaveBeenCalledWith(1, 20, true);
  });

  it('marks read, archives and restores one session', () => {
    controller.markRead('id-1');
    controller.archive('id-1');
    controller.restore('id-1');
    expect(mockService.markRead).toHaveBeenCalledWith('id-1');
    expect(mockService.archive).toHaveBeenCalledWith('id-1');
    expect(mockService.restore).toHaveBeenCalledWith('id-1');
  });

  it('reads one session', () => {
    controller.getSession('id-1');
    expect(mockService.getSession).toHaveBeenCalledWith('id-1');
  });
});
