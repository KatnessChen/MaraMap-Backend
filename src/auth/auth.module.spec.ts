import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import { AuthModule } from './auth.module';
import { AuthService } from './auth.service';

describe('AuthModule JWT secret', () => {
  const baseConfig = {
    ADMIN_USERNAME: 'test-admin',
    ADMIN_PASSWORD: 'test-password',
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_ANON_KEY: 'test-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
  };
  const original = process.env.JWT_SECRET;

  const compile = (config: Record<string, string>) =>
    Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => config],
        }),
        AuthModule,
      ],
    })
      .overrideProvider(SupabaseService)
      .useValue({ getClient: jest.fn().mockReturnValue({}) })
      .compile();

  beforeEach(() => {
    delete process.env.JWT_SECRET;
  });

  afterAll(() => {
    if (original === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = original;
  });

  it('refuses to start without a secret', async () => {
    await expect(compile(baseConfig)).rejects.toThrow(/JWT_SECRET/);
  });

  it('accepts tokens signed with the configured secret', async () => {
    const module = await compile({ ...baseConfig, JWT_SECRET: 'configured' });
    const token = module.get(JwtService).sign({ role: 'admin' });

    await expect(module.get(AuthService).verifyAdminToken(token)).resolves.toBe(
      true,
    );
  });

  it('rejects admin tokens signed with the old public fallback', async () => {
    const module = await compile({ ...baseConfig, JWT_SECRET: 'configured' });
    const forged = module
      .get(JwtService)
      .sign({ role: 'admin' }, { secret: 'maramap_secret_key_2026' });

    await expect(
      module.get(AuthService).verifyAdminToken(forged),
    ).resolves.toBe(false);
  });
});
