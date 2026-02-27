import { SupabaseAuthGuard } from './supabase-auth.guard';
import { AuthGuard } from '@nestjs/passport';

describe('SupabaseAuthGuard', () => {
  it('should be defined', () => {
    const guard = new SupabaseAuthGuard();
    expect(guard).toBeDefined();
  });

  it('should extend AuthGuard with supabase-jwt strategy', () => {
    const JwtGuardClass = AuthGuard('supabase-jwt');
    expect(SupabaseAuthGuard.prototype).toBeInstanceOf(JwtGuardClass);
  });
});
