/** YouTube's 11-character video id. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Returns a canonical watch URL for a video id, whatever URL was stored.
 *
 * Channel feeds occasionally hand us a channel/browse URL (or a URL whose `v`
 * parameter was stripped), which the app would open as a "channel overview"
 * web page instead of playing the clip. When the stored URL is not already a
 * playable video URL, rebuild it from the id we definitely have.
 */
export function toWatchUrl(rawUrl: string, videoId: string): string {
  const id = (videoId ?? '').trim();
  const validId = VIDEO_ID.test(id) ? id : '';
  if (!validId) return rawUrl;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return `https://www.youtube.com/watch?v=${validId}`;
  }

  const host = parsed.hostname.toLowerCase();
  const isYouTube = host === 'youtu.be' || host.endsWith('youtube.com');
  if (!isYouTube) return rawUrl;

  const path = parsed.pathname;
  const isPlayable =
    parsed.searchParams.get('v') === validId ||
    path === `/shorts/${validId}` ||
    path === `/embed/${validId}` ||
    path === `/live/${validId}` ||
    (host === 'youtu.be' && path === `/${validId}`);
  if (isPlayable) return rawUrl;

  return `https://www.youtube.com/watch?v=${validId}`;
}
