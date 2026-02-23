# Testing Instructions — MaraMap Backend

## Core Principle

Every feature, service method, and endpoint **must** be accompanied by tests. Tests are written alongside the implementation, not after. The three layers of testing must all be present for any production-ready module.

---

## Test Stack

| Tool                    | Purpose                                |
| ----------------------- | -------------------------------------- |
| **Jest**                | Test runner for unit and integration   |
| **@nestjs/testing**     | `TestingModule` for NestJS unit tests  |
| **Supertest**           | HTTP assertions for e2e tests          |
| **ts-jest**             | TypeScript support in Jest             |

---

## File Layout Convention

Co-locate unit and integration tests with the source file. E2e tests live in `test/`.

```
src/
  ingest/
    ingest.controller.spec.ts   ← unit test for controller
    ingest.service.spec.ts      ← unit test for service
    ingest.integration.spec.ts  ← integration test (real NestJS module, mocked Supabase)
    ingest.controller.ts
    ingest.service.ts
test/
  ingest.e2e-spec.ts            ← e2e test (full HTTP, mocked external deps)
```

---

## 1. Unit Tests (`*.spec.ts`)

### Scope

Test a **single class** in isolation. Mock all dependencies.

### Setup Rules

- Always use `Test.createTestingModule()` from `@nestjs/testing`.
- Mock every injected dependency with `jest.fn()` or `{ provide: X, useValue: mockObject }`.
- Never instantiate classes with `new` directly — always go through the NestJS DI container.
- Reset mocks in `beforeEach` using `jest.clearAllMocks()`.

### Controller Unit Tests

```typescript
describe('IngestController', () => {
  let controller: IngestController;
  let service: jest.Mocked<IngestService>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [IngestController],
      providers: [
        { provide: IngestService, useValue: { ingest: jest.fn() } },
        { provide: AuthGuard, useValue: { canActivate: jest.fn(() => true) } },
      ],
    }).compile();

    controller = module.get(IngestController);
    service = module.get(IngestService);
  });

  afterEach(() => jest.clearAllMocks());
});
```

### Service Unit Tests

- Mock the Supabase client entirely — never make real DB calls in unit tests.
- Test every branch: happy path, Supabase `.error` response, idempotency conflict, missing data.

```typescript
const mockSupabase = {
  from: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  single: jest.fn(),
};
```

### What to Test Per Service Method

| Scenario                                  | Expected behaviour                        |
| ----------------------------------------- | ----------------------------------------- |
| Supabase returns data successfully        | Returns mapped result                     |
| Supabase returns `{ error: ... }`         | Throws appropriate NestJS HTTP exception  |
| `source_id` already exists (ingest)       | Throws `ConflictException` (409)          |
| Record not found (single post)            | Throws `NotFoundException` (404)          |
| n8n webhook call (ingest)                 | Called once, fire-and-forget, not awaited |

---

## 2. Integration Tests (`*.integration.spec.ts`)

### Scope

Boot the **full NestJS module** for one domain. Mock only external I/O (Supabase, n8n HTTP calls). Verify that the module wiring (guards, pipes, interceptors) works correctly end-to-end within NestJS.

### Setup Rules

- Use `Test.createTestingModule()` with the real feature module imported.
- Override external providers using `.overrideProvider()`.
- Apply `app.useGlobalPipes(new ValidationPipe({ whitelist: true }))` to test DTO validation behaviour.
- Use `supertest` to make HTTP calls against the test app.

```typescript
describe('Ingest (Integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [IngestModule],
    })
      .overrideProvider(SupabaseService)
      .useValue(mockSupabaseService)
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
  });

  afterAll(() => app.close());
});
```

### What to Test

- DTO validation rejects malformed payloads (missing required fields, wrong types) → 400.
- `AuthGuard` blocks requests without a valid token → 401.
- Correct HTTP status codes are returned for all scenarios (202, 409, 404, 400).

---

## 3. E2E Tests (`test/*.e2e-spec.ts`)

### Scope

Test the **full application** (all modules loaded, global pipes/guards active) via HTTP. Mock only true external services: Supabase, n8n.

### Setup Rules

- Bootstrap with `AppModule` (same as production).
- Use environment variables from a `.env.test` file or `process.env` overrides in `beforeAll`.
- Mock `HttpService` (n8n webhook) and `SupabaseService` at the module level.
- Each test file covers **one resource** (e.g. `ingest.e2e-spec.ts`, `posts.e2e-spec.ts`).

```typescript
describe('POST /api/v1/ingest (e2e)', () => {
  it('returns 202 for a valid payload', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/ingest')
      .set('Authorization', `Bearer ${TEST_API_KEY}`)
      .send(validPayload)
      .expect(202);
  });

  it('returns 409 when source_id already exists', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/ingest')
      .set('Authorization', `Bearer ${TEST_API_KEY}`)
      .send(duplicatePayload)
      .expect(409);
  });

  it('returns 401 when Authorization header is missing', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/ingest')
      .send(validPayload)
      .expect(401);
  });
});
```

---

## Coverage Thresholds

**Excluded from coverage calculation:**
- `main.ts` — bootstrap entry point
- `*.module.ts` — NestJS module declarations

**Initial thresholds** (set in `jest.config.ts`, gradually increase as project matures):

| Metric | Current |
|--------|---------|
| Lines | 60% |
| Functions | 60% |
| Branches | 40% |
| Statements | 60% |

**Ratcheting strategy:**
- As coverage increases, the threshold automatically ratchets up
- When significant features are complete (ingest, posts, locations modules), increase thresholds to 75-80%
- Final target: 80% across all metrics (excluding bootstrap and module files)

Run coverage locally:

```bash
pnpm test:cov
```

The coverage report is automatically generated at `coverage/index.html` and will show which lines / branches are not covered.

---

## General Rules

- **Never** use `jest.setTimeout` to paper over slow tests. Fix the root cause instead.
- **Never** make real HTTP calls or real DB calls in unit or integration tests.
- **Always** assert on the exact HTTP status code and the shape of the response body.
- Test description format: `'should [verb] [outcome] when [condition]'`.
- Use `describe` blocks to group by method or scenario, not by file.
