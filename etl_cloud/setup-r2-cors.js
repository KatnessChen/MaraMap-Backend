/**
 * One-time setup: allow the admin frontend to PUT the Facebook export zip
 * straight to R2 with a presigned URL (the browser enforces CORS on
 * cross-origin PUTs; without this rule every direct upload fails preflight).
 *
 * Usage:
 *   node etl_cloud/setup-r2-cors.js https://your-frontend-domain.com [more origins...]
 *
 * http://localhost:3000 is always included so the flow works in local dev.
 * Requires the same R2_* env vars the backend uses (see .env).
 */
const {
  S3Client,
  GetBucketCorsCommand,
  PutBucketCorsCommand,
} = require('@aws-sdk/client-s3');

const BUCKET = process.env.R2_BUCKET_NAME;
if (!BUCKET || !process.env.R2_ENDPOINT) {
  console.error('❌ Missing R2_BUCKET_NAME / R2_ENDPOINT env vars (load .env first).');
  process.exit(1);
}

const origins = ['http://localhost:3000', ...process.argv.slice(2)];

const client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function main() {
  console.log(`🔧 Setting CORS on bucket "${BUCKET}" for origins:`);
  origins.forEach((o) => console.log(`   - ${o}`));

  await client.send(
    new PutBucketCorsCommand({
      Bucket: BUCKET,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: origins,
            AllowedMethods: ['PUT'],
            AllowedHeaders: ['content-type'],
            ExposeHeaders: ['etag'],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    }),
  );

  const { CORSRules } = await client.send(
    new GetBucketCorsCommand({ Bucket: BUCKET }),
  );
  console.log('✅ CORS rules now on the bucket:');
  console.log(JSON.stringify(CORSRules, null, 2));
}

main().catch((err) => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
