/**
 * Turn a raw User-Agent header into a short human label like "Chrome on macOS".
 * Pure + dependency-free so it can run in both the cloud app (session history,
 * new-device emails) and the self-hosted core build. Lives in core so the
 * `activeSessions` resolver can format sessions without depending on the
 * cloud-only LoginHistoryService.
 */
export const describeUserAgent = (ua?: string): string => {
  if (!ua || !ua.trim()) return 'an unknown device'
  const u = ua

  let os = ''
  if (/Windows NT/i.test(u)) os = 'Windows'
  else if (/iPhone|iPad|iPod/i.test(u)) os = 'iOS'
  else if (/Mac OS X|Macintosh/i.test(u)) os = 'macOS'
  else if (/Android/i.test(u)) os = 'Android'
  else if (/Linux/i.test(u)) os = 'Linux'

  let browser = ''
  // Order matters — Edge/Opera/Chrome all contain "Chrome".
  if (/Edg\//i.test(u)) browser = 'Edge'
  else if (/OPR\/|Opera/i.test(u)) browser = 'Opera'
  else if (/Firefox\//i.test(u)) browser = 'Firefox'
  else if (/Chrome\//i.test(u)) browser = 'Chrome'
  else if (/Safari\//i.test(u)) browser = 'Safari'

  if (browser && os) return `${browser} on ${os}`
  if (browser) return browser
  if (os) return os
  return 'an unknown device'
}
