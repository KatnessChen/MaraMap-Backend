const fs = require('fs');
const path = require('path');

// Configuration
const jsonPath = path.join(
  __dirname,
  './raw/facebook-chendavis1-2026-3-11-Hl65Zstp/your_facebook_activity/posts/your_posts__check_ins__photos_and_videos_1.json',
);
const POSTS_OUTPUT = path.join(__dirname, './output/posts.json');
const MEDIA_OUTPUT = path.join(__dirname, './output/media.json');

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
