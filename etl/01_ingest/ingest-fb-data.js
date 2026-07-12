const fs = require('fs');
const path = require('path');

// Configuration — BATCH must match a folder name under raw/, e.g. BATCH=2016
const BATCH = process.env.BATCH;
if (!BATCH) {
  console.error('❌ Missing BATCH env var. Usage: BATCH=<raw-folder-name> node ingest-fb-data.js');
  process.exit(1);
}

const RAW_BATCH_DIR = path.join(__dirname, './raw', BATCH);
const TARGET_FILENAME = 'your_posts__check_ins__photos_and_videos_1.json';

// The extracted export sits in a differently-named subfolder per batch
// (e.g. "FB下載資料(...)_JSON格式" or "facebook-chendavis1-..."), so search for it.
function findPostsJson(dir) {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { recursive: true });
  const match = entries.find(
    (entry) => path.basename(entry) === TARGET_FILENAME &&
      entry.includes(`your_facebook_activity${path.sep}posts`),
  );
  return match ? path.join(dir, match) : null;
}

const jsonPath = findPostsJson(RAW_BATCH_DIR);
if (!jsonPath) {
  console.error(`❌ Could not find ${TARGET_FILENAME} under raw/${BATCH}/`);
  process.exit(1);
}

const OUTPUT_DIR = path.join(__dirname, './output', BATCH);
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const POSTS_OUTPUT = path.join(OUTPUT_DIR, 'posts.json');
const MEDIA_OUTPUT = path.join(OUTPUT_DIR, 'media.json');

// Fix Facebook-specific Latin-1 encoding issues (mojibake)
function fixEncoding(str) {
  if (!str) return '';
  try {
    return Buffer.from(str, 'latin1').toString('utf8');
  } catch (e) {
    return str;
  }
}

console.log('🚀 Starting Facebook data ingest...');

try {
  if (!fs.existsSync(jsonPath)) {
    throw new Error('JSON file not found. Please check the path.');
  }

  const rawData = fs.readFileSync(jsonPath, 'utf8');
  const posts = JSON.parse(rawData);

  const postsResult = [];
  const mediaResult = [];

  posts.forEach((post) => {
    const text =
      post.data && post.data[0] ? fixEncoding(post.data[0].post) : '';
    const title = fixEncoding(post.title || '');

    const hasMedia = post.attachments && post.attachments.some(a =>
      a.data && a.data.some(item => item.media)
    );
    const isShare = /分享了.+則(貼文|相片|影片)/.test(title);
    const isWallComment = /已在.+的個人檔案上留言/.test(title);

    if (isWallComment) return;      // 留言在別人的時間軸，不是自己的貼文
    if (!text && isShare) return;  // 轉發且無自己的文字
    if (!text && !hasMedia) return; // 無文字、無媒體

    postsResult.push({
      timestamp: post.timestamp,
      date: new Date(post.timestamp * 1000).toISOString().split('T')[0],
      text,
      title,
    });

    if (post.attachments) {
      post.attachments.forEach((attachment) => {
        if (!attachment.data) return;
        attachment.data.forEach((item) => {
          if (!item.media) return;

          const mediaItem = {
            timestamp: post.timestamp, // FK back to post
            uri: item.media.uri,
            type:
              item.media.media_metadata &&
              item.media.media_metadata.video_metadata
                ? 'video'
                : 'photo',
            lat: null,
            lng: null,
            taken_at: item.media.creation_timestamp || post.timestamp,
          };

          const metadata = item.media.media_metadata;
          if (metadata) {
            const exif = (
              metadata.photo_metadata ||
              metadata.video_metadata ||
              {}
            ).exif_data;
            if (exif && exif[0] && exif[0].latitude && exif[0].longitude) {
              mediaItem.lat = exif[0].latitude;
              mediaItem.lng = exif[0].longitude;
            }
          }

          mediaResult.push(mediaItem);
        });
      });
    }
  });

  fs.writeFileSync(POSTS_OUTPUT, JSON.stringify(postsResult, null, 2));
  fs.writeFileSync(MEDIA_OUTPUT, JSON.stringify(mediaResult, null, 2));

  console.log(`✅ Ingest complete!`);
  console.log(`   posts → ${postsResult.length} records → ${POSTS_OUTPUT}`);
  console.log(`   media → ${mediaResult.length} records → ${MEDIA_OUTPUT}`);
} catch (error) {
  console.error('❌ Error during ingest:', error.message);
  process.exit(1);
}
