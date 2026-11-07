// A short, human description of a browser from its User-Agent: "Chrome on
// Windows". Shown next to a session so its owner can recognise it. Best
// effort; an unrecognised agent is "Unknown browser".

export function describeDevice(userAgent: string | undefined): string {
  const ua = userAgent ?? ''
  if (!ua) return 'Unknown device'
  const browser =
    /Edg(e|A|iOS)?\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /SamsungBrowser\//.test(ua) ? 'Samsung Internet'
    : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : /node|curl|wget|python|okhttp/i.test(ua) ? 'Script or app'
    : 'Unknown browser'
  const os =
    /Windows/.test(ua) ? 'Windows'
    : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : ''
  return os ? `${browser} on ${os}` : browser
}
