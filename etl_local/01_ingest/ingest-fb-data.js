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
// Sidecar list of the timestamps that came from album posts, so downstream
// partial re-runs can target exactly these without re-processing the whole batch.
const ALBUM_TS_OUTPUT = path.join(OUTPUT_DIR, 'album_timestamps.json');

// Fix Facebook-specific Latin-1 encoding issues (mojibake)
function fixEncoding(str) {
  if (!str) return '';
  try {
    return Buffer.from(str, 'latin1').toString('utf8');
  } catch (e) {
    return str;
  }
}

// Parse a leading Taiwanese ROC (民國) date from an album name, e.g.
// "105.2.28 日本東京馬拉松" → 2016-02-28, "104.6.29~104.7.15 ..." → 2015-06-29
// (range start). ROC year + 1911 = Gregorian year. Returns a UTC-noon epoch (in
// seconds) so the derived date string lands on the intended calendar day, else
// null. This is the true event date; cover/photo/edit times are upload times and
// can be days-to-months late, or the wrong year for albums re-covered later.
function parseRocDateToTimestamp(name) {
  if (!name) return null;
  const m = name.match(/^\s*(\d{2,3})\.(\d{1,2})\.(\d{1,2})/);
  if (!m) return null;
  const rocYear = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (rocYear < 1 || rocYear > 199) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  return Math.floor(Date.UTC(rocYear + 1911, month - 1, day, 12, 0, 0) / 1000);
}

// Build a media record from a Facebook media object (the shape found both at
// attachment.data[].media in the main feed and at album photos[]/cover_photo).
// postTimestamp is the FK back to the owning post.
function buildMediaItem(media, postTimestamp) {
  const mediaItem = {
    timestamp: postTimestamp,
    uri: media.uri,
    type:
      media.media_metadata && media.media_metadata.video_metadata
        ? 'video'
        : 'photo',
    lat: null,
    lng: null,
    taken_at: media.creation_timestamp || postTimestamp,
  };

  const metadata = media.media_metadata;
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

  return mediaItem;
}

// "新增 N 張相片到相簿" posts are NOT in your_posts__check_ins__photos_and_videos_1.json.
// Facebook's DYI export stores each album as its own file under posts/album/*.json.
// Find them all so album posts (e.g. race photo albums) aren't silently dropped.
function findAlbumJsons(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { recursive: true });
  return entries
    .filter(
      (entry) =>
        entry.includes(
          `your_facebook_activity${path.sep}posts${path.sep}album${path.sep}`,
        ) && entry.endsWith('.json'),
    )
    .map((entry) => path.join(dir, entry));
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
          mediaResult.push(buildMediaItem(item.media, post.timestamp));
        });
      });
    }
  });

  // --- Album posts (posts/album/*.json) — separate from the main feed file ---
  // Keep a set of timestamps already used by the main feed so an album's derived
  // timestamp never collides: media is FK'd by timestamp, and the DB unique key is
  // (user_id, fb_timestamp), so a collision would cross-link media or drop a post.
  const usedTimestamps = new Set(postsResult.map((p) => p.timestamp));
  // Media already claimed by a post we're keeping. Built from mediaResult (not
  // from every post in the export) on purpose: posts filtered out above never
  // reach the database, so a photo that only appears on one of those is NOT
  // covered and its album must still be imported.
  const claimedUris = new Set(mediaResult.map((m) => m.uri));
  const albumFiles = findAlbumJsons(RAW_BATCH_DIR);
  const albumTimestamps = [];
  let albumCount = 0;
  let mirrorCount = 0;

  albumFiles.forEach((albumPath) => {
    const album = JSON.parse(fs.readFileSync(albumPath, 'utf8'));
    const photos = Array.isArray(album.photos) ? album.photos : [];

    const text = fixEncoding(album.description || '');
    const title = fixEncoding(album.name || '');

    // Facebook's rolling system albums ("行動上傳", "相片", …) re-list photos
    // that are already attached to ordinary feed posts, so importing them
    // would duplicate every photo and invent an extra empty post. Detect them
    // by what they contain rather than by name: an album that adds no photo we
    // aren't already importing is a mirror, whatever it's called. A real event
    // album is not in the main feed file at all, so nothing of it is claimed.
    const photoUris = photos.map((p) => p.uri).filter(Boolean);
    if (photoUris.length > 0 && photoUris.every((uri) => claimedUris.has(uri))) {
      console.log(
        `   ⏭️  Skipped mirror album "${title}" — all ${photoUris.length} photo(s) already on imported posts`,
      );
      mirrorCount += 1;
      return;
    }

    // Album JSON has no post timestamp. Prefer the ROC date in the album name
    // (the true event date); else the earliest photo, which tracks when the
    // album's content actually happened. The cover photo comes after that: it
    // can be set — or left untouched — years away from the rest of the album.
    const photoTimestamps = photos
      .map((p) => p.creation_timestamp)
      .filter(Boolean);
    let timestamp =
      parseRocDateToTimestamp(title) ||
      (photoTimestamps.length ? Math.min(...photoTimestamps) : null) ||
      (album.cover_photo && album.cover_photo.creation_timestamp) ||
      album.last_modified_timestamp;

    if (!timestamp) return;          // nothing to anchor the post to
    if (!title && !text && !photos.length) return; // truly empty

    // Ensure uniqueness (see note above); nudge forward by whole seconds if taken.
    while (usedTimestamps.has(timestamp)) timestamp += 1;
    usedTimestamps.add(timestamp);

    postsResult.push({
      timestamp,
      date: new Date(timestamp * 1000).toISOString().split('T')[0],
      text,
      title,
    });

    photos.forEach((photo) => {
      if (!photo.uri) return;
      mediaResult.push(buildMediaItem(photo, timestamp));
    });
    albumTimestamps.push(timestamp);
    albumCount += 1;
  });

  if (albumCount > 0) {
    console.log(`   📸 Included ${albumCount} album post(s) from posts/album/`);
  }
  if (mirrorCount > 0) {
    console.log(
      `   🪞 Skipped ${mirrorCount} mirror album(s) — no photos lost, they belong to feed posts`,
    );
  }
  fs.writeFileSync(ALBUM_TS_OUTPUT, JSON.stringify(albumTimestamps, null, 2));

  fs.writeFileSync(POSTS_OUTPUT, JSON.stringify(postsResult, null, 2));
  fs.writeFileSync(MEDIA_OUTPUT, JSON.stringify(mediaResult, null, 2));

  console.log(`✅ Ingest complete!`);
  console.log(`   posts → ${postsResult.length} records → ${POSTS_OUTPUT}`);
  console.log(`   media → ${mediaResult.length} records → ${MEDIA_OUTPUT}`);
} catch (error) {
  console.error('❌ Error during ingest:', error.message);
  process.exit(1);
}
