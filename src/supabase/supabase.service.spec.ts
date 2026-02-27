import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from './supabase.service';

const mockConfigService = {
  getOrThrow: (key: string) => {
    const config: Record<string, string> = {
      SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    };
    if (!config[key]) throw new Error(`Missing env: ${key}`);
    return config[key];
  },
};

describe('SupabaseService', () => {
  let service: SupabaseService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupabaseService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<SupabaseService>(SupabaseService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return a Supabase client on first getClient() call', () => {
    const client = service.getClient();
    expect(client).toBeDefined();
    expect(typeof client.from).toBe('function');
  });

  it('should return the same client instance on multiple getClient() calls', () => {
    const client1 = service.getClient();
    const client2 = service.getClient();
    expect(client1).toBe(client2);
  });
});
