// AppModule needs this to boot, and CI has no .env file. Nothing in the e2e
// suite depends on its value.
process.env.JWT_SECRET ??= 'e2e-test-secret';
