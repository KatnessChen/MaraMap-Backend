const fs = require('fs');
const path = require('path');

// Configuration - Paths are adjusted for script location in /scripts folder
const jsonPath = path.join(__dirname, '../fb/facebook-chendavis1-2026-3-11-Hl65Zstp/your_facebook_activity/posts/your_posts__check_ins__photos_and_videos_1.json');
const outputPath = path.join(__dirname, '../marathon_gps_data.json');

// Fix Facebook-specific Latin-1 encoding issues (mojibake)
function fixEncoding(str) {
  if (!str) return '';
  try {
    return Buffer.from(str, 'latin1').toString('utf8');
  } catch (e) {
    return str;
  }
}

console.log('🚀 Starting Facebook data extraction...');

try {
  if (!fs.existsSync(jsonPath)) {
    throw new Error('JSON file not found. Please check the path.');
  }

  const rawData = fs.readFileSync(jsonPath, 'utf8');
  const posts = JSON.parse(rawData);
  const result = [];

  posts.forEach(post => {
    const text = post.data && post.data[0] ? fixEncoding(post.data[0].post) : '';
    const title = fixEncoding(post.title || '');

    // Skip empty posts with no text and no attachments
    if (!text && (!post.attachments || post.attachments.length === 0)) return;

    const extractedPost = {
      timestamp: post.timestamp,
      date: new Date(post.timestamp * 1000).toISOString().split('T')[0],
      text: text,
      title: title,
      media: []
    };

    if (post.attachments) {
      post.attachments.forEach(attachment => {
        if (attachment.data) {
          attachment.data.forEach(item => {
            if (item.media) {
              const mediaItem = {
                uri: item.media.uri,
                type: item.media.media_metadata && item.media.media_metadata.video_metadata ? 'video' : 'photo',
                lat: null,
                lng: null,
                taken_at: item.media.creation_timestamp || post.timestamp
              };

              const metadata = item.media.media_metadata;
              if (metadata) {
                const exif = (metadata.photo_metadata || metadata.video_metadata || {}).exif_data;
                if (exif && exif[0] && exif[0].latitude && exif[0].longitude) {
                  mediaItem.lat = exif[0].latitude;
                  mediaItem.lng = exif[0].longitude;
                }
              }
              extractedPost.media.push(mediaItem);
            }
          });
        }
      });
    }

    result.push(extractedPost);
  });

  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(`✅ Extraction complete! Total: ${result.length} posts extracted.`);
  console.log(`💾 Result saved to: ${outputPath}`);

} catch (error) {
  console.error('❌ Error during extraction:', error.message);
}
