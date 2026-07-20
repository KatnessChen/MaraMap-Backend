// One-off (idempotent) setup: install an R2 Object Lifecycle rule that auto-
// deletes abandoned manual-upload drafts left under `tmp/`.
//
// The admin "new post" flow uploads media to `tmp/<userId>/...` first,
// then the backend "claims" them into `manual/<userId>/...` when the post is
// actually created (see fb-posts.service.ts claimTmpMedia). Anything never
// claimed — the user uploaded, then closed the tab — stays in tmp forever
// unless swept. This rule is that sweep.
//
// Usage (env must contain the R2_* credentials, same as upload-to-r2.js):
//   node --env-file=.env utils/set-r2-lifecycle.js
//
// Optional: TMP_LIFECYCLE_DAYS overrides the retention window (default 7).
//
// Re-running is safe: it fetches the current lifecycle config, replaces only
// the rule with our ID, and leaves any other rules untouched.

const {
  S3Client,
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
} = require('@aws-sdk/client-s3');

const RULE_ID = 'expire-manual-tmp-uploads';
const TMP_PREFIX = 'tmp/';
const RETENTION_DAYS = parseInt(process.env.TMP_LIFECYCLE_DAYS || '7', 10);

const BUCKET_NAME = process.env.R2_BUCKET_NAME;

// Lifecycle is a bucket-level operation, so it needs an *Admin* R2 API token
// — the Object Read & Write token used for media uploads is not enough and
// returns "Access Denied". Surface that clearly instead of a raw SDK error.
function isAccessDenied(err) {
  return (
    err &&
    (err.name === 'AccessDenied' ||
      err.Code === 'AccessDenied' ||
      err.$metadata?.httpStatusCode === 403)
  );
}

function accessDeniedHint() {
  console.error(
    [
      '❌ Access Denied setting the bucket lifecycle rule.',
      '',
      '   Lifecycle config is a bucket-level operation and needs an R2 API token',
      '   with "Admin Read & Write" — an "Object Read & Write" token (the one used',
      '   for uploads) is not enough.',
      '',
      '   Fix it either way:',
      '   • Dashboard: R2 → your bucket → Settings → Object lifecycle rules →',
      `     add a rule with prefix "${TMP_PREFIX}", delete after ${RETENTION_DAYS} day(s).`,
      '   • Or re-run this script with a temporary Admin token:',
      '     R2_ACCESS_KEY_ID=<admin_key> R2_SECRET_ACCESS_KEY=<admin_secret> \\',
      '       node --env-file=.env utils/set-r2-lifecycle.js',
    ].join('\n'),
  );
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function main() {
  if (!BUCKET_NAME || !process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID) {
    console.error(
      '❌ Missing R2 env vars (R2_BUCKET_NAME / R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY).',
    );
    process.exit(1);
  }
  if (!Number.isInteger(RETENTION_DAYS) || RETENTION_DAYS < 1) {
    console.error(`❌ TMP_LIFECYCLE_DAYS must be a positive integer (got "${process.env.TMP_LIFECYCLE_DAYS}").`);
    process.exit(1);
  }

  const checkOnly = process.argv.includes('--check');

  // Read-only verification: list current rules and report whether ours is in
  // effect. Still a bucket-level read, so it needs an Admin token too.
  if (checkOnly) {
    let rules;
    try {
      const current = await s3.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: BUCKET_NAME }),
      );
      rules = current.Rules || [];
    } catch (err) {
      if (err.name === 'NoSuchLifecycleConfiguration') {
        console.log(`⚠️  ${BUCKET_NAME} has NO lifecycle rules configured.`);
        process.exit(1);
      }
      if (isAccessDenied(err)) {
        accessDeniedHint();
        process.exit(1);
      }
      throw err;
    }

    console.log(`ℹ️  ${BUCKET_NAME} has ${rules.length} lifecycle rule(s):`);
    console.log(JSON.stringify(rules, null, 2));

    const ours = rules.find((r) => r.ID === RULE_ID);
    if (!ours) {
      console.log(`\n⚠️  Rule "${RULE_ID}" NOT found.`);
      process.exit(1);
    }
    const prefix = ours.Filter?.Prefix ?? ours.Prefix;
    const days = ours.Expiration?.Days;
    const ok = ours.Status === 'Enabled' && prefix === TMP_PREFIX && days > 0;
    console.log(
      `\n${ok ? '✅' : '⚠️ '} Rule "${RULE_ID}": status=${ours.Status}, prefix="${prefix}", expire=${days} day(s).`,
    );
    if (prefix !== TMP_PREFIX) {
      console.log(
        `   ⚠️  Prefix should be exactly "${TMP_PREFIX}" — a broader/empty prefix would expire real media!`,
      );
    }
    process.exit(ok ? 0 : 1);
  }

  // Preserve any pre-existing rules; only swap out our own by ID.
  let existingRules = [];
  try {
    const current = await s3.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: BUCKET_NAME }),
    );
    existingRules = current.Rules || [];
  } catch (err) {
    // NoSuchLifecycleConfiguration = bucket simply has no rules yet.
    if (err.name === 'NoSuchLifecycleConfiguration') {
      // fall through with an empty rule set
    } else if (isAccessDenied(err)) {
      accessDeniedHint();
      process.exit(1);
    } else {
      console.error('❌ Failed to read current lifecycle config:', err.message);
      process.exit(1);
    }
  }

  const ourRule = {
    ID: RULE_ID,
    Filter: { Prefix: TMP_PREFIX },
    Status: 'Enabled',
    Expiration: { Days: RETENTION_DAYS },
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
  };

  const rules = existingRules.filter((r) => r.ID !== RULE_ID).concat(ourRule);

  try {
    await s3.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: BUCKET_NAME,
        LifecycleConfiguration: { Rules: rules },
      }),
    );
  } catch (err) {
    if (isAccessDenied(err)) {
      accessDeniedHint();
      process.exit(1);
    }
    throw err;
  }

  console.log(
    `✅ Lifecycle rule "${RULE_ID}" set on ${BUCKET_NAME}: objects under "${TMP_PREFIX}" expire after ${RETENTION_DAYS} day(s).`,
  );
  console.log(`   Total lifecycle rules on bucket: ${rules.length}.`);
}

main().catch((err) => {
  console.error('❌ Unexpected error:', err);
  process.exit(1);
});
